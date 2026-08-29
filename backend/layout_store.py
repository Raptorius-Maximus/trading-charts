"""
Server-side layout persistence.

Layout (number of panes, and each pane's symbol/timeframe/indicator
toggles) is saved to data/layout.json so any device on the LAN sees the
same last-used layout after a reload or a service restart -- not just
whatever was in one browser's localStorage.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LAYOUT_PATH = DATA_DIR / "layout.json"
DEFAULT_LAYOUT_PATH = DATA_DIR / "layout.default.json"

_lock = threading.Lock()

DEFAULT_LAYOUT: dict[str, Any] = {
    "numCharts": 4,
    "panes": [
        {"symbol": "NOVO-B.CO", "source": "yfinance", "interval": "1h", "ema20": True, "ema50": False, "rsi": False, "drawings": []},
        {"symbol": "MAERSK-B.CO", "source": "yfinance", "interval": "1h", "ema20": False, "ema50": False, "rsi": False, "drawings": []},
        {"symbol": "ERIC-B.ST", "source": "yfinance", "interval": "1h", "ema20": False, "ema50": False, "rsi": False, "drawings": []},
        {"symbol": "AAPL", "source": "yfinance", "interval": "1D", "ema20": False, "ema50": False, "rsi": False, "drawings": []},
    ],
}


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def load_layout() -> dict[str, Any]:
    with _lock:
        layout = _read_json(LAYOUT_PATH)
        if layout is not None:
            return layout
        layout = _read_json(DEFAULT_LAYOUT_PATH)
        if layout is None:
            layout = DEFAULT_LAYOUT
        return layout


def save_layout(layout: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _lock:
        tmp_path = LAYOUT_PATH.with_suffix(".json.tmp")
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(layout, f, indent=2)
        tmp_path.replace(LAYOUT_PATH)


def ensure_default_on_disk() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not DEFAULT_LAYOUT_PATH.exists():
        with DEFAULT_LAYOUT_PATH.open("w", encoding="utf-8") as f:
            json.dump(DEFAULT_LAYOUT, f, indent=2)


# ---------------------------------------------------------------- named layouts
# data/layouts/<name>.json -- snapshots the operator saves under a name and
# can switch between (like TradingView's layout list). The live layout
# (layout.json) is still what the page shows; loading a named one copies it
# over the live layout.
LAYOUTS_DIR = DATA_DIR / "layouts"
_NAME_OK = re.compile(r"^[A-Za-z0-9 _.\-]{1,40}$")


def list_layouts() -> list[dict[str, Any]]:
    LAYOUTS_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(LAYOUTS_DIR.glob("*.json")):
        try:
            d = _read_json(p) or {}
        except Exception:
            d = {}
        out.append({"name": p.stem, "numCharts": d.get("numCharts"), "symbols": [x.get("symbol") for x in d.get("panes", [])][: d.get("numCharts") or 4]})
    return out


def save_named_layout(name: str, layout: dict[str, Any]) -> None:
    if not _NAME_OK.match(name):
        raise ValueError("layout name: letters, digits, space, - _ . only (max 40)")
    LAYOUTS_DIR.mkdir(parents=True, exist_ok=True)
    (LAYOUTS_DIR / f"{name}.json").write_text(json.dumps(layout, indent=2))


def load_named_layout(name: str) -> dict[str, Any] | None:
    if not _NAME_OK.match(name):
        return None
    return _read_json(LAYOUTS_DIR / f"{name}.json")


def delete_named_layout(name: str) -> bool:
    if not _NAME_OK.match(name):
        return False
    p = LAYOUTS_DIR / f"{name}.json"
    if not p.exists():
        return False
    p.unlink()
    return True
