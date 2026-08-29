#!/usr/bin/env python3
"""
Reconnect-with-backoff test (spec verification step 3).

Opens the browser-facing candle websocket (the same one a pane in the UI
uses), waits for it to report the upstream Hyperliquid link is "live",
then forces that upstream link to drop via the backend's test-only
POST /debug/drop-stream hook -- equivalent to "close the socket in a
test" from the spec, since we don't get to physically unplug this
container's network. Watches the same websocket for the resulting
"reconnecting" -> "live" status sequence and prints the backend's log
lines for that window so both can be shown together as proof.

Usage:
    ./.venv/bin/python tests/kill_ws_test.py [base_host:port] [log_path]
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

import httpx
import websockets

HOST = sys.argv[1] if len(sys.argv) > 1 else "localhost:8850"
LOG_PATH = sys.argv[2] if len(sys.argv) > 2 else "./service.log"
COIN = "BTC"
INTERVAL = "1m"


async def main() -> int:
    log_start_size = 0
    try:
        with open(LOG_PATH, "rb") as f:
            f.seek(0, 2)
            log_start_size = f.tell()
    except FileNotFoundError:
        pass

    url = f"ws://{HOST}/ws/candles?source=hyperliquid&symbol={COIN}&interval={INTERVAL}"
    print(f"Connecting to {url}")
    async with websockets.connect(url, open_timeout=10) as ws:
        seen_states = []

        async def wait_for_state(target: str, timeout: float) -> bool:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(remaining, 0.1))
                except asyncio.TimeoutError:
                    return False
                msg = json.loads(raw)
                if msg.get("type") == "status":
                    seen_states.append(msg["state"])
                    print(f"  ws status: {msg['state']}")
                    if msg["state"] == target:
                        return True
            return False

        print("Waiting for initial 'live' status...")
        got_live = await wait_for_state("live", timeout=20)
        if not got_live:
            print(f"FAIL: never saw 'live' status. states seen: {seen_states}")
            return 1

        print(f"\nForcing upstream drop via POST http://{HOST}/debug/drop-stream ...")
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"http://{HOST}/debug/drop-stream", params={"coin": COIN, "interval": INTERVAL}, timeout=10)
        print(f"  drop-stream response: {resp.status_code} {resp.text}")
        if resp.status_code != 200 or not resp.json().get("dropped"):
            print("FAIL: drop-stream hook did not report a drop")
            return 1

        print("\nWaiting for 'reconnecting' status...")
        got_reconnecting = await wait_for_state("reconnecting", timeout=15)
        if not got_reconnecting:
            print(f"FAIL: never saw 'reconnecting' status. states seen: {seen_states}")
            return 1

        print("\nWaiting for 'live' status again (auto-reconnect)...")
        got_live_again = await wait_for_state("live", timeout=30)
        if not got_live_again:
            print(f"FAIL: never reconnected to 'live'. states seen: {seen_states}")
            return 1

        print(f"\nPASS: observed state sequence {seen_states}")

    print(f"\n--- backend log lines written during this test ({LOG_PATH}) ---")
    try:
        with open(LOG_PATH, "r") as f:
            f.seek(log_start_size)
            tail = f.read()
        relevant = "\n".join(line for line in tail.splitlines() if "hyperliquid" in line.lower())
        print(relevant or "(no matching log lines found)")
    except FileNotFoundError:
        print(f"(log file {LOG_PATH} not found)")

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
