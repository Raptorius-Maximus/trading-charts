"""Value-investing screener: Graham / Buffett / Munger metrics per stock.

Data comes from Yahoo (yfinance `Ticker.info`), which is delayed and
occasionally missing a field -- every metric is Optional and every check
says "n/a" rather than failing when the input is absent.

The universe is `data/universe.json` (seed list: S&P 500 + Nordic/DAX/FTSE
large caps; more can be added at runtime). Metrics are cached in
`data/fundamentals.json` and refreshed in a background thread: on startup
if the cache is older than REFRESH_AFTER, and on demand via /api/screener/refresh.

Checks (each is pass/fail/n/a; scores are counts of passes):

Graham -- "The Intelligent Investor", defensive-investor rules, adapted to
the fields Yahoo exposes:
  G1 size          market cap >= 2 bn (local currency; a blunt proxy)
  G2 current ratio >= 2
  G3 earnings      trailing EPS > 0
  G4 dividend      pays one (yield > 0)
  G5 growth        earnings growth > 0 (Yahoo gives one-year, Graham wanted ten)
  G6 P/E           <= 15
  G7 P/B           <= 1.5, OR P/E x P/B <= 22.5 (Graham's own relaxation)
  plus the Graham Number sqrt(22.5 x EPS x book value/share) and its
  margin vs the current price.

Buffett / Munger -- quality-and-moat rules distilled from the letters and
Munger's "Poor Charlie's Almanack":
  Q1 ROE           >= 15%  (consistently high return on equity)
  Q2 net margin    >= 10%
  Q3 gross margin  >= 40%  (pricing power = moat)
  Q4 debt/equity   <= 50%  (little debt)
  Q5 FCF yield     >= 5%   (owner earnings vs price)
  Q6 ROA           >= 7%
  Q7 revenue growth > 0
"""
from __future__ import annotations

import json
import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

import yfinance as yf

log = logging.getLogger("charts.fundamentals")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
UNIVERSE_PATH = DATA_DIR / "universe.json"
CACHE_PATH = DATA_DIR / "fundamentals.json"
REFRESH_AFTER = 24 * 3600  # seconds; Yahoo fundamentals move slowly
WORKERS = 4

_lock = threading.Lock()
_state: dict[str, Any] = {"refreshing": False, "progress": 0, "total": 0, "started": None}


# ---------------------------------------------------------------- helpers
def _num(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _check(value: Optional[float], ok: bool) -> Optional[bool]:
    return None if value is None else ok


def compute_metrics(info: dict[str, Any]) -> dict[str, Any]:
    price = _num(info.get("currentPrice")) or _num(info.get("regularMarketPrice"))
    eps = _num(info.get("trailingEps"))
    bvps = _num(info.get("bookValue"))
    pe = _num(info.get("trailingPE"))
    pb = _num(info.get("priceToBook"))
    mcap = _num(info.get("marketCap"))
    fcf = _num(info.get("freeCashflow"))
    div = _num(info.get("dividendYield"))  # yfinance: percent (3.96 == 3.96%)
    if div is not None and div < 0.5 and div > 0:  # older builds returned a fraction
        div = div * 100 if div < 0.3 else div
    de = _num(info.get("debtToEquity"))  # percent (63.3 == 0.633x)
    roe = _num(info.get("returnOnEquity"))
    roa = _num(info.get("returnOnAssets"))
    nm = _num(info.get("profitMargins"))
    gm = _num(info.get("grossMargins"))
    om = _num(info.get("operatingMargins"))
    cr = _num(info.get("currentRatio"))
    eg = _num(info.get("earningsGrowth"))
    rg = _num(info.get("revenueGrowth"))
    fcf_yield = (fcf / mcap) if (fcf is not None and mcap) else None
    pe_pb = (pe * pb) if (pe is not None and pb is not None) else None
    graham_number = None
    graham_margin = None
    if eps is not None and bvps is not None and eps > 0 and bvps > 0:
        graham_number = math.sqrt(22.5 * eps * bvps)
        if price:
            graham_margin = graham_number / price - 1

    graham = {
        "G1_size": _check(mcap, (mcap or 0) >= 2e9),
        "G2_current_ratio": _check(cr, (cr or 0) >= 2),
        "G3_earnings_positive": _check(eps, (eps or 0) > 0),
        "G4_pays_dividend": _check(div, (div or 0) > 0),
        "G5_earnings_growth": _check(eg, (eg or 0) > 0),
        "G6_pe_max_15": _check(pe, (pe or 99) <= 15),
        "G7_pb_or_pexpb": (
            None if (pb is None and pe_pb is None)
            else ((pb is not None and pb <= 1.5) or (pe_pb is not None and pe_pb <= 22.5))
        ),
    }
    quality = {
        "Q1_roe_15": _check(roe, (roe or 0) >= 0.15),
        "Q2_net_margin_10": _check(nm, (nm or 0) >= 0.10),
        "Q3_gross_margin_40": _check(gm, (gm or 0) >= 0.40),
        "Q4_low_debt": _check(de, (de if de is not None else 999) <= 50),
        "Q5_fcf_yield_5": _check(fcf_yield, (fcf_yield or 0) >= 0.05),
        "Q6_roa_7": _check(roa, (roa or 0) >= 0.07),
        "Q7_revenue_growth": _check(rg, (rg or 0) > 0),
    }
    return {
        "price": price, "currency": info.get("currency"),
        "market_cap": mcap, "pe": pe, "forward_pe": _num(info.get("forwardPE")),
        "pb": pb, "pe_x_pb": pe_pb, "eps": eps, "bvps": bvps,
        "graham_number": graham_number, "graham_margin": graham_margin,
        "current_ratio": cr, "debt_to_equity": de,
        "roe": roe, "roa": roa, "net_margin": nm, "gross_margin": gm, "op_margin": om,
        "fcf": fcf, "fcf_yield": fcf_yield, "dividend_yield": div,
        "payout_ratio": _num(info.get("payoutRatio")),
        "earnings_growth": eg, "revenue_growth": rg,
        "ev_ebitda": _num(info.get("enterpriseToEbitda")),
        "ps": _num(info.get("priceToSalesTrailing12Months")),
        "beta": _num(info.get("beta")),
        "graham": graham, "quality": quality,
        "graham_score": sum(1 for v in graham.values() if v is True),
        "quality_score": sum(1 for v in quality.values() if v is True),
    }


def fetch_one(entry: dict[str, Any]) -> dict[str, Any]:
    sym = entry["symbol"]
    row = {"symbol": sym, "name": entry.get("name") or "", "sector": entry.get("sector") or "",
           "market": entry.get("market") or "", "ok": False, "updated": int(time.time())}
    try:
        info = yf.Ticker(sym).info or {}
    except Exception as exc:  # yfinance raises a grab-bag
        row["error"] = str(exc)[:160]
        return row
    if not info or (info.get("currentPrice") is None and info.get("regularMarketPrice") is None):
        row["error"] = "no data from Yahoo"
        return row
    row["name"] = info.get("longName") or info.get("shortName") or row["name"]
    row["sector"] = info.get("sector") or row["sector"]
    row["industry"] = info.get("industry")
    row["exchange"] = info.get("exchange")
    row["ok"] = True
    row.update(compute_metrics(info))
    return row


# ---------------------------------------------------------------- storage
def load_universe() -> list[dict[str, Any]]:
    if not UNIVERSE_PATH.exists():
        return []
    return json.loads(UNIVERSE_PATH.read_text()).get("symbols", [])


def save_universe(symbols: list[dict[str, Any]]) -> None:
    data = json.loads(UNIVERSE_PATH.read_text()) if UNIVERSE_PATH.exists() else {}
    data["symbols"] = symbols
    UNIVERSE_PATH.write_text(json.dumps(data, indent=1))


def load_cache() -> dict[str, Any]:
    if not CACHE_PATH.exists():
        return {"updated": None, "rows": {}}
    try:
        return json.loads(CACHE_PATH.read_text())
    except ValueError:
        return {"updated": None, "rows": {}}


def save_cache(cache: dict[str, Any]) -> None:
    tmp = CACHE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache))
    tmp.replace(CACHE_PATH)


# ---------------------------------------------------------------- refresh
def refresh(symbols: Optional[list[str]] = None) -> None:
    """Fetch metrics for `symbols` (default: the whole universe) and merge
    into the cache. Runs in the calling thread; use start_refresh() for
    background."""
    universe = load_universe()
    entries = [e for e in universe if symbols is None or e["symbol"] in symbols]
    with _lock:
        _state.update(refreshing=True, progress=0, total=len(entries), started=int(time.time()))
    cache = load_cache()
    rows = cache.setdefault("rows", {})
    done = 0
    try:
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for row in pool.map(fetch_one, entries):
                rows[row["symbol"]] = row
                done += 1
                with _lock:
                    _state["progress"] = done
                if done % 25 == 0:
                    save_cache(cache)
        cache["updated"] = int(time.time())
        save_cache(cache)
    finally:
        with _lock:
            _state["refreshing"] = False
    log.info("fundamentals refresh done: %d symbols", done)


def start_refresh(symbols: Optional[list[str]] = None) -> bool:
    with _lock:
        if _state["refreshing"]:
            return False
    threading.Thread(target=refresh, args=(symbols,), daemon=True, name="fundamentals-refresh").start()
    return True


def maybe_refresh_on_startup() -> None:
    cache = load_cache()
    age = time.time() - (cache.get("updated") or 0)
    if age > REFRESH_AFTER or not cache.get("rows"):
        log.info("fundamentals cache stale (age %.0fs) -- refreshing in background", age)
        start_refresh()


def status() -> dict[str, Any]:
    with _lock:
        st = dict(_state)
    cache = load_cache()
    st["cache_updated"] = cache.get("updated")
    st["rows"] = len(cache.get("rows", {}))
    return st


def add_symbol(symbol: str, market: str = "Added") -> dict[str, Any]:
    """Add a ticker to the universe and fetch it right now (blocking, ~1s)."""
    sym = symbol.strip().upper()
    universe = load_universe()
    if not any(e["symbol"] == sym for e in universe):
        universe.append({"symbol": sym, "name": "", "sector": "", "market": market})
        save_universe(universe)
    row = fetch_one({"symbol": sym, "market": market})
    cache = load_cache()
    cache.setdefault("rows", {})[sym] = row
    save_cache(cache)
    return row


def all_rows() -> list[dict[str, Any]]:
    return list(load_cache().get("rows", {}).values())
