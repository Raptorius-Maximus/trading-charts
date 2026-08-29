#!/usr/bin/env python3
"""
Automated smoke test (spec verification step 2).

Fetches candles for one crypto symbol (Hyperliquid, live) and one stock
symbol (yfinance, delayed) through the running backend's /api/candles
endpoint, and asserts the response is non-empty and correctly shaped.

Usage:
    ./.venv/bin/python tests/smoke_test.py [base_url]

Exits 0 on success, 1 on any failure, printing a clear PASS/FAIL per check.
"""

from __future__ import annotations

import sys

import httpx

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8850"

REQUIRED_KEYS = {"time", "open", "high", "low", "close", "volume"}

CASES = [
    {"source": "hyperliquid", "symbol": "BTC", "interval": "1m", "expect_quality": "live"},
    {"source": "yfinance", "symbol": "AAPL", "interval": "1h", "expect_quality": "delayed"},
]

failures = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global failures
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}" + (f" -- {detail}" if detail and not condition else ""))
    if not condition:
        failures += 1


def run_case(case: dict) -> None:
    url = f"{BASE_URL}/api/candles"
    params = {"source": case["source"], "symbol": case["symbol"], "interval": case["interval"], "limit": 50}
    print(f"\n--- {case['source']} / {case['symbol']} / {case['interval']} ---")
    try:
        resp = httpx.get(url, params=params, timeout=20)
    except httpx.HTTPError as exc:
        check(f"{case['source']}: request succeeded", False, str(exc))
        return

    check(f"{case['source']}: HTTP 200", resp.status_code == 200, f"got {resp.status_code}: {resp.text[:200]}")
    if resp.status_code != 200:
        return

    body = resp.json()
    check(f"{case['source']}: response has 'candles' list", isinstance(body.get("candles"), list))
    candles = body.get("candles", [])
    check(f"{case['source']}: candles non-empty", len(candles) > 0, f"got {len(candles)} candles")
    check(
        f"{case['source']}: quality label is '{case['expect_quality']}'",
        body.get("quality") == case["expect_quality"],
        f"got quality={body.get('quality')!r}",
    )

    if candles:
        first = candles[0]
        check(f"{case['source']}: candle has required keys", REQUIRED_KEYS.issubset(first.keys()), f"keys={list(first.keys())}")
        check(
            f"{case['source']}: OHLCV values are numeric",
            all(isinstance(first[k], (int, float)) for k in REQUIRED_KEYS if k in first),
        )
        times = [c["time"] for c in candles]
        check(f"{case['source']}: candles sorted oldest-first", times == sorted(times))
        last = candles[-1]
        print(f"    last candle: time={last['time']} O={last['open']} H={last['high']} L={last['low']} C={last['close']} V={last['volume']}")


def check_health() -> None:
    print("--- /health ---")
    try:
        resp = httpx.get(f"{BASE_URL}/health", timeout=10)
    except httpx.HTTPError as exc:
        check("health: request succeeded", False, str(exc))
        return
    check("health: HTTP 200", resp.status_code == 200)
    body = resp.json()
    check("health: ok == true", body.get("ok") is True, str(body))
    check("health: sources present", "hyperliquid" in body.get("sources", {}) and "yfinance" in body.get("sources", {}))


def main() -> int:
    print(f"Smoke test against {BASE_URL}")
    check_health()
    for case in CASES:
        run_case(case)
    print(f"\n{'ALL CHECKS PASSED' if failures == 0 else f'{failures} CHECK(S) FAILED'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
