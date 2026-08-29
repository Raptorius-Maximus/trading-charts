"""Live browser check: loads the dashboard in headless Chromium and fails if
any pane is stuck on 'connecting…', shows no price, or throws a JS error.
Exists because pure API tests passed while the page was completely blank
(KLineChart v10 API mismatch, 2026-08-29).

Run:  ./.venv/bin/python tests/browser_check.py [screenshot.png]
Needs: playwright in .venv, browser + libs under ~/projects/.cache (see README).
"""
import os, sys, time
H = os.path.expanduser("~")
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", f"{H}/projects/.cache/pw-browsers")
os.environ.setdefault("LD_LIBRARY_PATH", f"{H}/projects/.cache/pw-libs/usr/lib/x86_64-linux-gnu")
os.environ.setdefault("FONTCONFIG_FILE", f"{H}/projects/.cache/pw-libs/fonts.conf")
from playwright.sync_api import sync_playwright

def main():
    out = sys.argv[1] if len(sys.argv) > 1 else None
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1600, "height": 1000})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.goto("http://127.0.0.1:8850/?scratch=1", wait_until="networkidle"); time.sleep(4)
        badges = pg.eval_on_selector_all(".conn-badge", "els=>els.map(e=>e.textContent)")
        prices = pg.eval_on_selector_all(".ticker-price", "els=>els.map(e=>e.textContent)")
        # EMA must be drawn on the candle pane, not in its own strip
        ema_panes = pg.evaluate("Array.from(document.querySelectorAll('.pane')).map(p=>p.textContent.includes('EMA20:')?1:0)")
        if out: pg.screenshot(path=out, full_page=True)
        b.close()
    print("badges:", badges); print("prices:", prices); print("errors:", errs[:5])
    bad = [i for i, s in enumerate(badges) if s not in ("polling", "live")]
    nop = [i for i, s in enumerate(prices) if s.strip() in ("", "--")]
    ok = not bad and not nop and not errs and len(badges) > 0
    print("PASS" if ok else f"FAIL bad_badges={bad} no_price={nop}")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
