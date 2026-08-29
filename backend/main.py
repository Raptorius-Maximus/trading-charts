"""
FastAPI backend for the self-hosted trading dashboard.

One process serves:
  - the static frontend (plain HTML/CSS/vanilla JS, Lightweight Charts
    vendored locally -- no CDN calls from the browser)
  - GET  /health              liveness + configured data sources
  - GET  /api/candles         historical candle snapshot for any source
  - GET  /api/layout          saved multi-chart layout
  - PUT  /api/layout          save the layout (server-side, JSON file)
  - WS   /ws/candles          live candle stream, proxied from Hyperliquid
  - POST /debug/drop-stream   test-only hook used by tests/kill_ws_test.py
                               to exercise the reconnect-with-backoff path
                               on demand (see that file for why).

Why FastAPI over Flask: the live crypto feed is a long-lived websocket
proxy that has to run its own reconnect loop concurrently with serving
HTTP requests. FastAPI/Starlette's native asyncio support means that
proxy is just another coroutine sharing the event loop with the HTTP
routes -- no extra thread/greenlet plumbing the way it would need under
Flask's synchronous WSGI model. Flask would work for the HTTP+static
half of this alone, but the websocket half is where async pays for
itself.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import ipaddress

from fastapi import Request

from . import ai_analysis, analysis, fundamentals, layout_store, quotes
from .data_sources import SOURCES, DataSourceError
from .hyperliquid_stream import manager as hl_manager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("charts.main")

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    layout_store.ensure_default_on_disk()
    fundamentals.maybe_refresh_on_startup()
    quotes.start_alert_thread()
    logger.info("startup complete; sources=%s", list(SOURCES.keys()))
    yield
    logger.info("shutting down")


app = FastAPI(title="Trading Dashboard", lifespan=lifespan)

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR / "static")), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/health")
async def health() -> JSONResponse:
    sources = {
        name: {"quality": src.quality, "label": src.quality_label, "streaming": src.supports_stream}
        for name, src in SOURCES.items()
    }
    return JSONResponse({"ok": True, "sources": sources})


@app.get("/api/candles")
async def api_candles(
    source: str = Query(...),
    symbol: str = Query(...),
    interval: str = Query(...),
    limit: int = Query(300, ge=1, le=20000),
) -> JSONResponse:
    src = SOURCES.get(source)
    if src is None:
        raise HTTPException(status_code=400, detail=f"unknown source '{source}'. known: {list(SOURCES)}")
    try:
        candles = await asyncio.to_thread(src.get_candles, symbol, interval, limit)
    except DataSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return JSONResponse({
        "source": source,
        "symbol": symbol.upper(),
        "interval": interval,
        "quality": src.quality,
        "quality_label": src.quality_label,
        "candles": candles,
    })


@app.get("/api/symbol-search")
async def symbol_search(q: str = Query(..., min_length=1)) -> JSONResponse:
    """Company/fund name -> ticker lookup (Yahoo search), so a pane can be
    driven by typing e.g. "Novo Nordisk" without knowing it's NOVO-B.CO on
    the Copenhagen exchange. yfinance-backed only; Hyperliquid coins are a
    short fixed list typed directly (BTC, ETH, ...)."""
    src = SOURCES.get("yfinance")
    try:
        results = await asyncio.to_thread(src.search, q, 8)
    except DataSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return JSONResponse({"query": q, "results": results})


@app.get("/screener")
async def screener_page() -> FileResponse:
    return FileResponse(str(FRONTEND_DIR / "screener.html"))


@app.get("/api/screener")
async def api_screener() -> JSONResponse:
    """All cached fundamentals rows + refresh status. The page does its own
    sorting/filtering; ~600 rows is small."""
    return JSONResponse({"status": fundamentals.status(), "rows": fundamentals.all_rows()})


@app.post("/api/screener/refresh")
async def api_screener_refresh() -> JSONResponse:
    started = fundamentals.start_refresh()
    return JSONResponse({"started": started, "status": fundamentals.status()})


@app.post("/api/screener/add")
async def api_screener_add(symbol: str = Query(..., min_length=1)) -> JSONResponse:
    row = await asyncio.to_thread(fundamentals.add_symbol, symbol)
    if not row.get("ok"):
        raise HTTPException(status_code=502, detail=row.get("error") or f"no data for '{symbol}'")
    return JSONResponse(row)


@app.get("/api/quotes")
async def api_quotes(symbols: str = Query(..., min_length=1)) -> JSONResponse:
    syms = [s for s in symbols.split(",") if s.strip()][:60]
    rows = await asyncio.to_thread(quotes.get_quotes, syms)
    return JSONResponse({"quotes": rows})


@app.get("/api/watchlist")
async def api_watchlist() -> JSONResponse:
    return JSONResponse({"symbols": quotes.load_watchlist()})


@app.put("/api/watchlist")
async def api_watchlist_put(body: dict) -> JSONResponse:
    syms = body.get("symbols")
    if not isinstance(syms, list):
        raise HTTPException(status_code=400, detail="body must be {symbols: [...]}")
    return JSONResponse({"symbols": quotes.save_watchlist(syms)})


@app.get("/api/alerts")
async def api_alerts() -> JSONResponse:
    return JSONResponse({"alerts": quotes.load_alerts()})


@app.post("/api/alerts")
async def api_alerts_add(body: dict) -> JSONResponse:
    try:
        alert = quotes.add_alert(str(body.get("symbol", "")), str(body.get("condition", "")), float(body.get("price")), str(body.get("note", "")))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse(alert)


@app.delete("/api/alerts/{alert_id}")
async def api_alerts_delete(alert_id: str) -> JSONResponse:
    if not quotes.delete_alert(alert_id):
        raise HTTPException(status_code=404, detail="no such alert")
    return JSONResponse({"ok": True})


@app.post("/api/alerts/{alert_id}/seen")
async def api_alerts_seen(alert_id: str) -> JSONResponse:
    quotes.mark_seen(alert_id)
    return JSONResponse({"ok": True})


@app.get("/api/layouts")
async def api_layouts() -> JSONResponse:
    return JSONResponse({"layouts": layout_store.list_layouts()})


@app.post("/api/layouts/{name}")
async def api_layouts_save(name: str, layout: dict) -> JSONResponse:
    if "numCharts" not in layout or "panes" not in layout:
        raise HTTPException(status_code=400, detail="layout must include numCharts and panes")
    try:
        layout_store.save_named_layout(name, layout)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse({"ok": True})


@app.get("/api/layouts/{name}")
async def api_layouts_get(name: str) -> JSONResponse:
    d = layout_store.load_named_layout(name)
    if d is None:
        raise HTTPException(status_code=404, detail="no such layout")
    return JSONResponse(d)


@app.delete("/api/layouts/{name}")
async def api_layouts_delete(name: str) -> JSONResponse:
    if not layout_store.delete_named_layout(name):
        raise HTTPException(status_code=404, detail="no such layout")
    return JSONResponse({"ok": True})


@app.get("/api/analysis/{symbol}")
async def api_analysis(symbol: str, force: bool = Query(False)) -> JSONResponse:
    """Graham / Buffett / Munger reading of one stock (deterministic, cached 12 h)."""
    try:
        d = await asyncio.to_thread(analysis.get, symbol, force)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # yfinance grab-bag
        raise HTTPException(status_code=502, detail=f"analysis failed: {exc}"[:200]) from exc
    return JSONResponse(d)


def _is_lan(request: Request) -> bool:
    """True only for a direct private-network client. Anything that came
    through a reverse proxy carries X-Forwarded-* headers and is refused,
    even if the proxy itself sits on the LAN."""
    for h in ("x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"):
        if h in request.headers:
            return False
    host = request.client.host if request.client else ""
    try:
        return ipaddress.ip_address(host).is_private or host == "127.0.0.1"
    except ValueError:
        return False


@app.get("/api/ai-analysis/status")
async def api_ai_status(request: Request) -> JSONResponse:
    return JSONResponse({"lan": _is_lan(request), "configured": ai_analysis.configured()})


@app.post("/api/ai-analysis/{symbol}")
async def api_ai_analysis(symbol: str, request: Request, force: bool = Query(False)) -> JSONResponse:
    """AI second opinion. LAN only (two locks: the public proxy refuses POST,
    and this handler refuses non-private or proxied clients)."""
    if not _is_lan(request):
        raise HTTPException(status_code=403, detail="AI analysis is only available on the home network")
    if not ai_analysis.configured():
        raise HTTPException(status_code=503, detail="AI analysis is not set up yet (no API key)")
    try:
        d = await asyncio.to_thread(ai_analysis.get, symbol, force)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI analysis failed: {exc}"[:300]) from exc
    return JSONResponse(d)


@app.get("/pine/auto_lines.pine")
async def pine_auto_lines() -> FileResponse:
    return FileResponse(str(ROOT / "pine" / "auto_lines.pine"), media_type="text/plain")


@app.get("/api/layout")
async def get_layout() -> JSONResponse:
    return JSONResponse(layout_store.load_layout())


@app.put("/api/layout")
async def put_layout(layout: dict) -> JSONResponse:
    if "numCharts" not in layout or "panes" not in layout:
        raise HTTPException(status_code=400, detail="layout must include numCharts and panes")
    layout_store.save_layout(layout)
    return JSONResponse({"ok": True})


@app.websocket("/ws/candles")
async def ws_candles(websocket: WebSocket) -> None:
    await websocket.accept()
    params = websocket.query_params
    source = params.get("source", "hyperliquid")
    symbol = params.get("symbol", "")
    interval = params.get("interval", "1m")

    if source != "hyperliquid":
        await websocket.send_json({"type": "error", "message": f"streaming not supported for source '{source}'"})
        await websocket.close()
        return
    if not symbol:
        await websocket.send_json({"type": "error", "message": "symbol is required"})
        await websocket.close()
        return

    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    try:
        coin, hl_interval = await hl_manager.subscribe(symbol, interval, queue)
    except ValueError as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        await websocket.close()
        return

    sender_task = asyncio.create_task(_pump_queue_to_ws(queue, websocket))
    try:
        while True:
            # We don't expect client->server messages, but reading keeps
            # the disconnect (client closed tab) detectable promptly.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        sender_task.cancel()
        await hl_manager.unsubscribe(coin, hl_interval, queue)


async def _pump_queue_to_ws(queue: "asyncio.Queue", websocket: WebSocket) -> None:
    try:
        while True:
            message = await queue.get()
            await websocket.send_json(message)
    except asyncio.CancelledError:
        pass
    except Exception:
        pass


@app.post("/debug/drop-stream")
async def debug_drop_stream(coin: str = Query(...), interval: str = Query("1m")) -> JSONResponse:
    """Test-only: force the named upstream Hyperliquid stream to drop so the
    reconnect-with-backoff path can be observed. See tests/kill_ws_test.py."""
    from .data_sources import HYPERLIQUID_INTERVALS

    hl_interval = HYPERLIQUID_INTERVALS.get(interval, interval)
    dropped = await hl_manager.force_drop(coin, hl_interval)
    return JSONResponse({"ok": True, "dropped": dropped})
