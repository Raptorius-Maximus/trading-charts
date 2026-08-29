"""
Server-side layout persistence.

Layout (number of panes, and each pane's symbol/timeframe/indicator
toggles) is saved to data/layout.json so any device on the LAN sees the
same last-used layout after a reload or a service restart -- not just
whatever was in one browser's localStorage.
"""

from __future__ import annotations

import json
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
