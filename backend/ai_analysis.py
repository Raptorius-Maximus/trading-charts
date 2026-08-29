"""AI second opinion on one stock -- LAN only.

Takes the deterministic analysis (backend/analysis.py: facts + the three
rule-based readings) and asks Claude to write the reading a thoughtful
value investor would give: what the numbers say, what they hide, what to
read in the annual report, and where Graham, Buffett and Munger would
disagree with each other. The model only sees numbers we already
computed; it is told to reason from them, not to invent figures.

Access: POST only (the public proxy refuses POST), and main.py additionally
requires a private-network client with no proxy headers. Both must hold.

Key: ANTHROPIC_API_KEY from <project>/.env (placed with secret-drop, never
via chat). Cached 24 h per symbol in data/ai/<SYMBOL>.json.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

import anthropic

from . import analysis

log = logging.getLogger("charts.ai")

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
DATA_DIR = ROOT / "data" / "ai"
TTL = 24 * 3600
MODEL = "claude-opus-5"

SYSTEM = """You are a seasoned value investor writing a second opinion for a private investor in Denmark who is new to
stock analysis but smart, and who reads Graham, Buffett and Munger. You are given a JSON dossier on one stock:
current metrics, up to four fiscal years of statements, and a rule-based reading already produced by software.

Write in plain English, no jargon without a short explanation, no hype. Use ONLY numbers from the dossier; if a
number you'd want is missing, say so and say where in the annual report to find it. Be candid where the rules
flatter or punish the company unfairly (cyclicals, banks, insurers, companies with big buybacks, currencies).
Structure, with these exact headings on their own lines:

## In one paragraph
## What the numbers say
## What the numbers hide
## Where the three would disagree
## What to read before buying
## Verdict

Under Verdict: one of "Wonderful business, fair price", "Wonderful business, too expensive", "Cheap but ordinary",
"Cheap for a reason", "Cyclical bet", or "Pass" — then two sentences why. End with one line:
"This is a reading of public numbers, not personal advice." Keep the whole thing under 600 words."""


def load_key() -> Optional[str]:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if line.startswith("ANTHROPIC_API_KEY=") :
                v = line.split("=", 1)[1].strip().strip('"').strip("'")
                if v:
                    return v
    return None


def configured() -> bool:
    return load_key() is not None


def get(symbol: str, force: bool = False) -> dict[str, Any]:
    sym = symbol.strip().upper()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    p = DATA_DIR / f"{sym}.json"
    if p.exists() and not force:
        try:
            d = json.loads(p.read_text())
            if time.time() - d.get("generated", 0) < TTL:
                return d
        except ValueError:
            pass
    key = load_key()
    if not key:
        raise RuntimeError("no API key configured")
    dossier = analysis.get(sym)
    client = anthropic.Anthropic(api_key=key)
    t0 = time.time()
    response = client.messages.create(
        model=MODEL,
        max_tokens=4000,
        output_config={"effort": "medium"},
        system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": "Dossier:\n" + json.dumps(dossier, ensure_ascii=False)}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("the model declined to write this one")
    text = "".join(b.text for b in response.content if b.type == "text").strip()
    if not text:
        raise RuntimeError("empty answer from the model")
    u = response.usage
    cost = (u.input_tokens * 5 + u.output_tokens * 25 + (u.cache_read_input_tokens or 0) * 0.5
            + (u.cache_creation_input_tokens or 0) * 6.25) / 1e6
    d = {"symbol": sym, "generated": int(time.time()), "model": MODEL, "text": text,
         "usage": {"input": u.input_tokens, "output": u.output_tokens, "cache_read": u.cache_read_input_tokens,
                   "seconds": round(time.time() - t0, 1), "approx_usd": round(cost, 4)}}
    p.write_text(json.dumps(d, ensure_ascii=False))
    log.info("ai analysis %s: %s tokens in / %s out, ~$%.3f", sym, u.input_tokens, u.output_tokens, cost)
    return d
