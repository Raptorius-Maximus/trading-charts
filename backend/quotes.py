"""Quotes, watchlist and price alerts.

quotes:    last price / previous close / day + 52-week range from Yahoo's
           fast_info (delayed like everything from Yahoo). Cached 60 s per
           symbol so a watchlist of 30 names doesn't hammer Yahoo.
watchlist: a plain list of symbols in data/watchlist.json.
alerts:    data/alerts.json; a background thread checks every 60 s and
           marks an alert triggered when the last price crosses its level.
           Alerts fire server-side, so they work while the page is closed;
           the page shows them the next time it polls.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import yfinance as yf

log = logging.getLogger("charts.quotes")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
WATCHLIST_PATH = DATA_DIR / "watchlist.json"
ALERTS_PATH = DATA_DIR / "alerts.json"
QUOTE_TTL = 60
ALERT_INTERVAL = 60

_lock = threading.Lock()
_quote_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f  # NaN check


def get_quote(symbol: str) -> dict[str, Any]:
    sym = symbol.strip().upper()
    now = time.time()
    with _lock:
        hit = _quote_cache.get(sym)
    if hit and now - hit[0] < QUOTE_TTL:
        return hit[1]
    q: dict[str, Any] = {"symbol": sym, "ok": False}
    try:
        fi = yf.Ticker(sym).fast_info
        last = _num(fi.get("lastPrice"))
        prev = _num(fi.get("previousClose"))
        q.update(
            ok=last is not None,
            price=last, prev_close=prev,
            change=(last - prev) if (last is not None and prev) else None,
            change_pct=((last / prev - 1) * 100) if (last is not None and prev) else None,
            day_high=_num(fi.get("dayHigh")), day_low=_num(fi.get("dayLow")),
            year_high=_num(fi.get("yearHigh")), year_low=_num(fi.get("yearLow")),
            currency=fi.get("currency"), volume=_num(fi.get("lastVolume")),
            updated=int(now),
        )
    except Exception as exc:  # yfinance raises a grab-bag
        q["error"] = str(exc)[:120]
    with _lock:
        _quote_cache[sym] = (now, q)
    return q


def get_quotes(symbols: list[str]) -> list[dict[str, Any]]:
    return [get_quote(s) for s in symbols if s.strip()]


# ---------------------------------------------------------------- watchlist
def _read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except ValueError:
        return default


def _write(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(path)


def load_watchlist() -> list[str]:
    return _read(WATCHLIST_PATH, {"symbols": ["NOVO-B.CO", "MAERSK-B.CO", "ERIC-B.ST", "VOLV-B.ST", "AAPL", "MSFT"]}).get("symbols", [])


def save_watchlist(symbols: list[str]) -> list[str]:
    clean: list[str] = []
    for s in symbols:
        s = str(s).strip().upper()
        if s and s not in clean:
            clean.append(s)
    _write(WATCHLIST_PATH, {"symbols": clean})
    return clean


# ---------------------------------------------------------------- alerts
def load_alerts() -> list[dict[str, Any]]:
    return _read(ALERTS_PATH, {"alerts": []}).get("alerts", [])


def save_alerts(alerts: list[dict[str, Any]]) -> None:
    _write(ALERTS_PATH, {"alerts": alerts})


def add_alert(symbol: str, condition: str, price: float, note: str = "") -> dict[str, Any]:
    if condition not in ("above", "below"):
        raise ValueError("condition must be 'above' or 'below'")
    alert = {
        "id": uuid.uuid4().hex[:10], "symbol": symbol.strip().upper(), "condition": condition,
        "price": float(price), "note": note[:120], "created": int(time.time()),
        "triggered_at": None, "triggered_price": None, "seen": False,
    }
    alerts = load_alerts()
    alerts.append(alert)
    save_alerts(alerts)
    return alert


def delete_alert(alert_id: str) -> bool:
    alerts = load_alerts()
    keep = [a for a in alerts if a["id"] != alert_id]
    if len(keep) == len(alerts):
        return False
    save_alerts(keep)
    return True


def mark_seen(alert_id: str) -> None:
    alerts = load_alerts()
    for a in alerts:
        if a["id"] == alert_id:
            a["seen"] = True
    save_alerts(alerts)


def check_alerts_once() -> int:
    alerts = load_alerts()
    pending = [a for a in alerts if not a.get("triggered_at")]
    if not pending:
        return 0
    fired = 0
    for a in pending:
        q = get_quote(a["symbol"])
        price = q.get("price")
        if price is None:
            continue
        hit = (a["condition"] == "above" and price >= a["price"]) or (a["condition"] == "below" and price <= a["price"])
        if hit:
            a["triggered_at"] = int(time.time())
            a["triggered_price"] = price
            fired += 1
            log.info("alert fired: %s %s %s (last %s)", a["symbol"], a["condition"], a["price"], price)
    if fired:
        save_alerts(alerts)
    return fired


def _alert_loop() -> None:
    while True:
        try:
            check_alerts_once()
        except Exception as exc:  # keep the loop alive whatever Yahoo does
            log.warning("alert check failed: %s", exc)
        time.sleep(ALERT_INTERVAL)


def start_alert_thread() -> None:
    threading.Thread(target=_alert_loop, daemon=True, name="alert-check").start()
