"""
Pluggable market-data sources.

Every source implements the tiny `DataSource` interface below: one method,
`get_candles`, that returns a list of OHLCV dicts. Adding a new broker or
exchange later (Binance, Alpaca, Polygon, ...) means writing one class with
that one method and registering it in SOURCES at the bottom of this file --
nothing else in the app needs to change.

Candle shape returned by get_candles (all sources must match this):
    {"time": <unix seconds, UTC>, "open": float, "high": float,
     "low": float, "close": float, "volume": float}

`time` is unix seconds because that is what TradingView's Lightweight
Charts expects natively for its time scale.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from typing import Any

import httpx
import pandas as pd
import yfinance as yf

HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info"
HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws"
YAHOO_SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search"

# Frontend timeframe labels -> per-source interval strings.
# ("1D" uses a capital D in the UI to read cleanly next to "1h"/"4h"; every
# source maps it to its own lowercase-day spelling internally.)
HYPERLIQUID_INTERVALS = {
    "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1D": "1d",
}

# yfinance has no native 4h bucket, and its 1m/5m/15m history windows are
# short. We fetch the closest supported base interval/period and resample
# with pandas where needed (4h only). This keeps the public interface
# ("1m","5m","15m","1h","4h","1D") identical across sources.
YFINANCE_PLAN = {
    "1m": {"interval": "1m", "period": "5d"},
    "5m": {"interval": "5m", "period": "1mo"},
    "15m": {"interval": "15m", "period": "1mo"},
    "1h": {"interval": "60m", "period": "3mo"},
    "4h": {"interval": "60m", "period": "6mo", "resample": "4h"},
    "1D": {"interval": "1d", "period": "2y"},
}


class DataSourceError(Exception):
    """Raised for any user-facing data failure (bad symbol, upstream down, ...)."""


class DataSource(ABC):
    name: str
    quality: str  # "live" or "delayed"
    quality_label: str  # human string shown in the UI badge
    supports_stream: bool = False

    @abstractmethod
    def get_candles(self, symbol: str, interval: str, limit: int = 300) -> list[dict[str, Any]]:
        """Return up to `limit` most-recent candles, oldest first."""
        raise NotImplementedError

    def normalize_interval(self, interval: str) -> str:
        raise NotImplementedError


class HyperliquidSource(DataSource):
    name = "hyperliquid"
    quality = "live"
    quality_label = "live"
    supports_stream = True

    def normalize_interval(self, interval: str) -> str:
        if interval not in HYPERLIQUID_INTERVALS:
            raise DataSourceError(f"unsupported interval '{interval}' for hyperliquid")
        return HYPERLIQUID_INTERVALS[interval]

    def get_candles(self, symbol: str, interval: str, limit: int = 300) -> list[dict[str, Any]]:
        hl_interval = self.normalize_interval(interval)
        coin = symbol.strip().upper()
        span_ms = _interval_to_ms(hl_interval) * limit
        end = int(time.time() * 1000)
        start = end - span_ms
        body = {
            "type": "candleSnapshot",
            "req": {"coin": coin, "interval": hl_interval, "startTime": start, "endTime": end},
        }
        try:
            resp = httpx.post(HYPERLIQUID_INFO_URL, json=body, timeout=10)
        except httpx.HTTPError as exc:
            raise DataSourceError(f"hyperliquid unreachable: {exc}") from exc
        if resp.status_code != 200:
            raise DataSourceError(f"hyperliquid error {resp.status_code}: {resp.text[:200]}")
        try:
            raw = resp.json()
        except ValueError as exc:
            raise DataSourceError(f"hyperliquid returned invalid JSON: {exc}") from exc
        if not isinstance(raw, list) or len(raw) == 0:
            raise DataSourceError(f"unknown or empty symbol '{coin}' on hyperliquid")
        candles = [
            {
                "time": c["t"] // 1000,
                "open": float(c["o"]),
                "high": float(c["h"]),
                "low": float(c["l"]),
                "close": float(c["c"]),
                "volume": float(c["v"]),
            }
            for c in raw
        ]
        return candles[-limit:]


class YFinanceSource(DataSource):
    name = "yfinance"
    quality = "delayed"
    quality_label = "delayed ~15 min"
    supports_stream = False

    def normalize_interval(self, interval: str) -> str:
        if interval not in YFINANCE_PLAN:
            raise DataSourceError(f"unsupported interval '{interval}' for yfinance")
        return interval

    def get_candles(self, symbol: str, interval: str, limit: int = 300) -> list[dict[str, Any]]:
        plan = YFINANCE_PLAN[self.normalize_interval(interval)]
        sym = symbol.strip().upper()
        try:
            ticker = yf.Ticker(sym)
            df = ticker.history(period=plan["period"], interval=plan["interval"], auto_adjust=False)
        except Exception as exc:  # yfinance raises a grab-bag of exception types
            raise DataSourceError(f"yfinance error for '{sym}': {exc}") from exc
        if df is None or df.empty:
            raise DataSourceError(f"unknown or empty symbol '{sym}' on yfinance")
        if "resample" in plan:
            df = df.resample(plan["resample"]).agg(
                {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
            ).dropna(how="any")
        candles = [
            {
                "time": int(pd.Timestamp(idx).timestamp()),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row["Volume"]) if not pd.isna(row["Volume"]) else 0.0,
            }
            for idx, row in df.iterrows()
        ]
        return candles[-limit:]

    def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        """Look up ticker symbols by company/fund name via Yahoo's public
        search endpoint, so a pane can be driven by typing "Novo Nordisk"
        instead of requiring the caller to already know it's NOVO-B.CO on
        the Copenhagen exchange."""
        query = query.strip()
        if not query:
            return []
        try:
            resp = httpx.get(
                YAHOO_SEARCH_URL,
                params={"q": query, "quotesCount": limit, "newsCount": 0},
                headers={"User-Agent": "Mozilla/5.0 (compatible; charts-dashboard/1.0)"},
                timeout=8,
            )
        except httpx.HTTPError as exc:
            raise DataSourceError(f"symbol search unreachable: {exc}") from exc
        if resp.status_code != 200:
            raise DataSourceError(f"symbol search error {resp.status_code}: {resp.text[:200]}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise DataSourceError(f"symbol search returned invalid JSON: {exc}") from exc
        results = []
        for q in data.get("quotes", [])[:limit]:
            symbol = q.get("symbol")
            if not symbol:
                continue
            results.append({
                "symbol": symbol,
                "name": q.get("shortname") or q.get("longname") or symbol,
                "exchange": q.get("exchange") or q.get("exchDisp") or "",
            })
        return results


def _interval_to_ms(interval: str) -> int:
    unit = interval[-1]
    value = int(interval[:-1])
    if unit == "m":
        return value * 60_000
    if unit == "h":
        return value * 3_600_000
    if unit == "d":
        return value * 86_400_000
    raise DataSourceError(f"cannot parse interval '{interval}'")


SOURCES: dict[str, DataSource] = {
    "hyperliquid": HyperliquidSource(),
    "yfinance": YFinanceSource(),
}
