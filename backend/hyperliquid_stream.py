"""
Manages the backend's upstream websocket connection(s) to Hyperliquid and
fans live candle updates out to however many browser panes are watching
the same (coin, interval) pair.

Why proxy instead of letting the browser connect straight to Hyperliquid?
So the reconnect-with-backoff logic lives in one place (here, testable and
loggable server-side), and so N browser panes watching the same symbol
share a single upstream subscription instead of opening N of them.

Honest failure states: every subscriber is told the current link state
("connecting" | "live" | "reconnecting") the moment it joins and on every
change, so a pane never shows a stale price while pretending it's live.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field

import websockets

from .data_sources import HYPERLIQUID_INTERVALS, HYPERLIQUID_WS_URL

logger = logging.getLogger("charts.hyperliquid_stream")

INITIAL_BACKOFF = 1.0
MAX_BACKOFF = 30.0


@dataclass
class StreamState:
    coin: str
    interval: str
    status: str = "connecting"  # connecting | live | reconnecting
    last_candle: dict | None = None
    clients: set = field(default_factory=set)
    task: asyncio.Task | None = None
    force_drop: bool = False


class HyperliquidStreamManager:
    def __init__(self) -> None:
        self._streams: dict[tuple[str, str], StreamState] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, coin: str, interval: str, client_queue: "asyncio.Queue") -> tuple[str, str]:
        if interval not in HYPERLIQUID_INTERVALS:
            raise ValueError(f"unsupported interval '{interval}'")
        hl_interval = HYPERLIQUID_INTERVALS[interval]
        coin = coin.strip().upper()
        key = (coin, hl_interval)
        async with self._lock:
            state = self._streams.get(key)
            if state is None:
                state = StreamState(coin=coin, interval=hl_interval)
                self._streams[key] = state
                state.task = asyncio.create_task(self._run(state))
            state.clients.add(client_queue)
        await client_queue.put({"type": "status", "state": state.status})
        if state.last_candle is not None:
            await client_queue.put({"type": "candle", "candle": state.last_candle})
        return coin, hl_interval

    async def unsubscribe(self, coin: str, hl_interval: str, client_queue: "asyncio.Queue") -> None:
        key = (coin, hl_interval)
        async with self._lock:
            state = self._streams.get(key)
            if state is None:
                return
            state.clients.discard(client_queue)
            if not state.clients:
                if state.task:
                    state.task.cancel()
                del self._streams[key]

    async def force_drop(self, coin: str, hl_interval: str) -> bool:
        """Test hook: force the upstream connection for (coin, interval) to
        drop right now, so the reconnect-with-backoff path can be observed
        and its log lines captured. Used by tests/kill_ws_test.py."""
        key = (coin.strip().upper(), hl_interval)
        async with self._lock:
            state = self._streams.get(key)
        if state is None:
            return False
        state.force_drop = True
        return True

    async def _broadcast(self, state: StreamState, message: dict) -> None:
        for q in list(state.clients):
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                pass

    async def _run(self, state: StreamState) -> None:
        backoff = INITIAL_BACKOFF
        tag = f"coin={state.coin} interval={state.interval}"
        while True:
            try:
                logger.info("[hyperliquid] connecting %s", tag)
                async with websockets.connect(
                    HYPERLIQUID_WS_URL, open_timeout=10, ping_interval=15, ping_timeout=10
                ) as ws:
                    await ws.send(json.dumps({
                        "method": "subscribe",
                        "subscription": {"type": "candle", "coin": state.coin, "interval": state.interval},
                    }))
                    state.status = "live"
                    backoff = INITIAL_BACKOFF
                    logger.info("[hyperliquid] connected %s", tag)
                    await self._broadcast(state, {"type": "status", "state": "live"})
                    async for raw in ws:
                        if state.force_drop:
                            state.force_drop = False
                            logger.warning("[hyperliquid] forced drop (test hook) %s", tag)
                            raise ConnectionError("forced drop for test")
                        msg = json.loads(raw)
                        if msg.get("channel") == "candle":
                            d = msg["data"]
                            candle = {
                                "time": d["t"] // 1000,
                                "open": float(d["o"]),
                                "high": float(d["h"]),
                                "low": float(d["l"]),
                                "close": float(d["c"]),
                                "volume": float(d["v"]),
                            }
                            state.last_candle = candle
                            await self._broadcast(state, {"type": "candle", "candle": candle})
            except asyncio.CancelledError:
                logger.info("[hyperliquid] stream cancelled %s", tag)
                raise
            except Exception as exc:
                state.status = "reconnecting"
                logger.warning(
                    "[hyperliquid] disconnected %s error=%r; reconnecting in %.1fs",
                    tag, exc, backoff,
                )
                await self._broadcast(state, {"type": "status", "state": "reconnecting"})
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF)


manager = HyperliquidStreamManager()
