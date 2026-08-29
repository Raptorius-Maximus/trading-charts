"""One-stock analysis "the way Graham, Buffett and Munger would read it".

Deterministic -- no AI, no API key. It pulls the current metrics (same as
the screener) plus up to four years of income statement / balance sheet /
cash flow from Yahoo, computes the things the three of them actually
looked at, and writes the findings in plain language under three headings.
Every sentence is backed by a number that is also returned in `facts`.

Cached per symbol for 12 h in data/analysis/<SYMBOL>.json.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any, Optional

import yfinance as yf

from .fundamentals import compute_metrics

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "analysis"
TTL = 12 * 3600

# Sectors where earnings follow a commodity price rather than the business.
CYCLICAL_SECTORS = {"Energy", "Basic Materials"}
CYCLICAL_INDUSTRY_WORDS = ("Oil", "Gas", "Mining", "Steel", "Shipping", "Semiconductor Equipment", "Airlines", "Chemicals", "Aluminum", "Copper", "Gold", "Coal", "Homebuilding")


def _f(v: Any) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(x) or math.isinf(x)) else x


def _row(df, *names) -> list[Optional[float]]:
    """Values of the first matching row, oldest -> newest."""
    if df is None or getattr(df, "empty", True):
        return []
    for n in names:
        if n in df.index:
            vals = [_f(v) for v in df.loc[n].tolist()]
            return list(reversed(vals))  # yfinance columns are newest-first
    return []


def _years(df) -> list[str]:
    if df is None or getattr(df, "empty", True):
        return []
    return list(reversed([str(c)[:4] for c in df.columns]))


def _fmt_money(v: Optional[float], cur: str = "") -> str:
    if v is None:
        return "n/a"
    a = abs(v)
    s = f"{v/1e12:.2f} T" if a >= 1e12 else f"{v/1e9:.2f} B" if a >= 1e9 else f"{v/1e6:.0f} M" if a >= 1e6 else f"{v:,.0f}"
    return f"{s} {cur}".strip()


def _pct(v: Optional[float]) -> str:
    return "n/a" if v is None else f"{v*100:.0f}%"


def build(symbol: str) -> dict[str, Any]:
    sym = symbol.strip().upper()
    t = yf.Ticker(sym)
    info = t.info or {}
    if not info or (info.get("currentPrice") is None and info.get("regularMarketPrice") is None):
        raise ValueError(f"no data from Yahoo for '{sym}'")
    m = compute_metrics(info)
    cur = info.get("currency") or ""
    name = info.get("longName") or info.get("shortName") or sym
    sector = info.get("sector") or ""
    industry = info.get("industry") or ""

    inc, bs, cf = t.income_stmt, t.balance_sheet, t.cashflow
    years = _years(inc)
    rev = _row(inc, "Total Revenue", "Operating Revenue")
    ni = _row(inc, "Net Income Common Stockholders", "Net Income")
    eps = _row(inc, "Diluted EPS")
    opi = _row(inc, "Operating Income", "Total Operating Income As Reported")
    intexp = _row(inc, "Interest Expense", "Interest Expense Non Operating")
    fcf_hist = _row(cf, "Free Cash Flow")
    buyback = _row(cf, "Repurchase Of Capital Stock")
    divs = _row(cf, "Cash Dividends Paid")
    equity = _row(bs, "Stockholders Equity")
    debt = _row(bs, "Total Debt")
    retained = _row(bs, "Retained Earnings")

    price = m["price"]
    # ------------------------------------------------------------ derived
    loss_years = sum(1 for v in ni if v is not None and v < 0)
    eps_clean = [v for v in eps if v is not None]
    eps_first, eps_last = (eps_clean[0], eps_clean[-1]) if len(eps_clean) >= 2 else (None, None)
    eps_swing = None
    if len(eps_clean) >= 2 and max(eps_clean) > 0:
        eps_swing = (max(eps_clean) - min(eps_clean)) / max(abs(max(eps_clean)), 1e-9)
    rev_cagr = None
    rc = [v for v in rev if v]
    if len(rc) >= 2 and rc[0] > 0 and rc[-1] > 0:
        rev_cagr = (rc[-1] / rc[0]) ** (1 / (len(rc) - 1)) - 1
    interest_cover = None
    if opi and intexp and opi[-1] is not None and intexp[-1]:
        interest_cover = opi[-1] / abs(intexp[-1])
    cyclical = sector in CYCLICAL_SECTORS or any(w in industry for w in CYCLICAL_INDUSTRY_WORDS)
    fcf_pos_years = sum(1 for v in fcf_hist if v is not None and v > 0)
    buyback_total = sum(-v for v in buyback if v is not None and v < 0)
    div_total = sum(-v for v in divs if v is not None and v < 0)
    shareholder_yield = None
    if m["market_cap"] and (buyback_total or div_total) and len(buyback) >= 1:
        n = max(len([v for v in buyback if v is not None]), len([v for v in divs if v is not None]), 1)
        shareholder_yield = (buyback_total + div_total) / n / m["market_cap"]
    equity_growth = None
    ec = [v for v in equity if v]
    if len(ec) >= 2 and ec[0] > 0:
        equity_growth = ec[-1] / ec[0] - 1
    hi, lo = _f(info.get("fiftyTwoWeekHigh")), _f(info.get("fiftyTwoWeekLow"))
    pos52 = (price - lo) / (hi - lo) if (price and hi and lo and hi > lo) else None

    facts = {
        "name": name, "symbol": sym, "sector": sector, "industry": industry, "currency": cur,
        "price": price, "market_cap": m["market_cap"], "week52_high": hi, "week52_low": lo, "pos_in_52w": pos52,
        "pe": m["pe"], "forward_pe": m["forward_pe"], "pb": m["pb"], "pe_x_pb": m["pe_x_pb"],
        "eps": m["eps"], "bvps": m["bvps"], "graham_number": m["graham_number"], "graham_margin": m["graham_margin"],
        "current_ratio": m["current_ratio"], "debt_to_equity": m["debt_to_equity"],
        "total_debt": _f(info.get("totalDebt")), "total_cash": _f(info.get("totalCash")),
        "roe": m["roe"], "roa": m["roa"], "net_margin": m["net_margin"], "gross_margin": m["gross_margin"], "op_margin": m["op_margin"],
        "fcf": m["fcf"], "fcf_yield": m["fcf_yield"], "dividend_yield": m["dividend_yield"], "payout_ratio": m["payout_ratio"],
        "ev_ebitda": m["ev_ebitda"], "beta": m["beta"],
        "years": years, "revenue": rev, "net_income": ni, "eps_history": eps, "fcf_history": fcf_hist,
        "equity": equity, "debt": debt, "retained_earnings": retained,
        "loss_years": loss_years, "eps_swing": eps_swing, "revenue_cagr": rev_cagr, "interest_cover": interest_cover,
        "cyclical": cyclical, "fcf_positive_years": fcf_pos_years, "years_available": len(years),
        "buybacks_total": buyback_total, "dividends_total": div_total, "shareholder_yield": shareholder_yield,
        "equity_growth": equity_growth,
        "graham_checks": m["graham"], "quality_checks": m["quality"],
        "graham_score": m["graham_score"], "quality_score": m["quality_score"],
    }

    # ------------------------------------------------------------ Graham
    g: list[dict[str, str]] = []
    def say(lst, kind, text): lst.append({"kind": kind, "text": text})
    if m["pe"] is not None:
        say(g, "good" if m["pe"] <= 15 else "bad", f"Price is {m['pe']:.1f}× last year's earnings (Graham's ceiling: 15).")
    if m["pe_x_pb"] is not None:
        say(g, "good" if m["pe_x_pb"] <= 22.5 else "bad", f"P/E × P/B = {m['pe_x_pb']:.1f} (his limit 22.5; P/B alone is {m['pb']:.1f}).")
    if m["graham_number"] and price:
        mg = m["graham_margin"]
        say(g, "good" if mg >= 0.33 else "warn" if mg >= 0 else "bad",
            f"Graham number √(22.5 × EPS × book/share) = {m['graham_number']:.2f} {cur} vs price {price:.2f}: "
            + (f"{mg*100:.0f}% margin of safety — he liked a third." if mg >= 0 else f"price is {abs(mg)*100:.0f}% ABOVE it."))
    else:
        say(g, "bad", "Graham number cannot be computed (negative earnings or book value) — automatic fail for a defensive investor.")
    if m["current_ratio"] is not None:
        say(g, "good" if m["current_ratio"] >= 2 else "warn" if m["current_ratio"] >= 1 else "bad",
            f"Current ratio {m['current_ratio']:.2f} (he wanted ≥ 2: short-term assets covering short-term bills twice).")
    if years:
        ep = ", ".join(f"{y}: {v:.2f}" for y, v in zip(years, eps) if v is not None) if eps else "n/a"
        if loss_years:
            say(g, "bad", f"Earnings per share {ep} — {loss_years} loss year(s) in the last {len(years)}. Graham demanded ten straight profitable years.")
        elif eps_swing is not None and eps_swing > 0.5:
            say(g, "warn", f"Earnings per share {ep} — swings of more than half from peak to trough. Not the steady record he wanted; the one-year growth tick in the screener is this year vs a weak year.")
        else:
            say(g, "good", f"Earnings per share {ep} — steady and positive across the years Yahoo provides ({len(years)}; he wanted ten, so keep checking the annual reports).")
    if m["dividend_yield"]:
        say(g, "good", f"Pays a dividend ({m['dividend_yield']:.2f}%), payout {_pct(m['payout_ratio'])} of profit.")
    else:
        say(g, "warn", "No dividend — Graham wanted an uninterrupted record of payments.")
    if m["market_cap"]:
        say(g, "good" if m["market_cap"] >= 2e9 else "bad", f"Size {_fmt_money(m['market_cap'], cur)} — {'large enough' if m['market_cap'] >= 2e9 else 'too small'} for his defensive list.")

    # ------------------------------------------------------------ Buffett
    b: list[dict[str, str]] = []
    if cyclical:
        say(b, "bad", f"{industry or sector}: a price-taker. It sells what everyone else sells at a price set elsewhere. Buffett avoided most of these; his exceptions were the lowest-cost operators. High returns here usually mean the commodity is high, not that the business is great.")
    elif m["gross_margin"] is not None:
        say(b, "good" if m["gross_margin"] >= 0.4 else "warn", f"Gross margin {_pct(m['gross_margin'])} — {'strong pricing power, a sign of a moat' if m['gross_margin'] >= 0.4 else 'thin; customers can push on price'}.")
    if m["roe"] is not None:
        say(b, "good" if m["roe"] >= 0.15 else "bad", f"Return on equity {_pct(m['roe'])} (return on assets {_pct(m['roa'])}). He wanted ≥ 15% year after year" + (" — check that it holds in a bad year." if cyclical else "."))
    if m["net_margin"] is not None:
        say(b, "good" if m["net_margin"] >= 0.1 else "warn", f"Net margin {_pct(m['net_margin'])}, operating margin {_pct(m['op_margin'])}.")
    if m["fcf_yield"] is not None:
        say(b, "good" if m["fcf_yield"] >= 0.05 else "warn", f"Owner earnings: free cash flow {_fmt_money(m['fcf'], cur)} = {m['fcf_yield']*100:.1f}% of the price you pay" + (f"; positive in {fcf_pos_years} of {len(fcf_hist)} years" if fcf_hist else "") + ".")
    if m["debt_to_equity"] is not None:
        d, c = facts["total_debt"], facts["total_cash"]
        say(b, "good" if m["debt_to_equity"] <= 50 else "warn" if m["debt_to_equity"] <= 100 else "bad",
            f"Debt {_fmt_money(d, cur)} vs cash {_fmt_money(c, cur)}; debt/equity {m['debt_to_equity']:.0f}%" + (f", operating profit covers interest {interest_cover:.1f}×" if interest_cover else "") + ". He liked businesses that don't need to borrow.")
    if rev_cagr is not None:
        say(b, "good" if rev_cagr > 0.05 else "warn" if rev_cagr >= 0 else "bad", f"Revenue {_fmt_money(rc[0], cur)} → {_fmt_money(rc[-1], cur)} over {len(rc)-1} years ({rev_cagr*100:.1f}%/yr).")
    if equity_growth is not None:
        say(b, "good" if equity_growth > 0 else "warn", f"Book value {'grew' if equity_growth > 0 else 'shrank'} {abs(equity_growth)*100:.0f}% over the period — retained profit {'is compounding' if equity_growth > 0 else 'is not building up'} inside the company.")
    if shareholder_yield:
        say(b, "good", f"Returned about {shareholder_yield*100:.1f}% of today's market value per year to owners (buybacks {_fmt_money(buyback_total, cur)} + dividends {_fmt_money(div_total, cur)} over the period).")

    # ------------------------------------------------------------ Munger
    mu: list[dict[str, str]] = []
    if cyclical:
        say(mu, "bad", "Invert — what kills it? A lower commodity price, which nobody can forecast, including the managers. That is the whole outcome, and it is outside the company's control.")
    else:
        worst = []
        if m["debt_to_equity"] and m["debt_to_equity"] > 100: worst.append("a balance sheet that needs refinancing in a bad year")
        if loss_years: worst.append("a record of loss years")
        if m["gross_margin"] is not None and m["gross_margin"] < 0.3: worst.append("thin margins that one price war can erase")
        if pos52 is not None and pos52 > 0.9: worst.append("a price near its 52-week high, so the easy money has been made")
        say(mu, "warn" if worst else "good", "Invert — what kills it? " + ("; ".join(worst).capitalize() + "." if worst else "Nothing obvious in the numbers; the risk is in the story, so read the annual report for it."))
    say(mu, "good" if (not cyclical and m["roe"] and m["roe"] >= 0.15 and not loss_years) else "warn",
        "Would you hold it 20 years without looking? " + ("The numbers say the business earns its own way — the kind of thing he'd sit on." if (not cyclical and m["roe"] and m["roe"] >= 0.15 and not loss_years) else "Not on these numbers; it needs watching, which he considered a defect."))
    if pos52 is not None:
        say(mu, "warn" if pos52 > 0.85 else "good" if pos52 < 0.35 else "info", f"Price sits at {pos52*100:.0f}% of its 52-week range ({lo:.2f}–{hi:.2f}). {'Buying what has just doubled is where the crowd is.' if pos52 > 0.85 else 'Closer to the low than the high — where he liked to shop, if the business is sound.' if pos52 < 0.35 else ''}".strip())
    if m["pe"] and m["forward_pe"]:
        say(mu, "info", f"Analysts expect earnings to {'fall' if m['forward_pe'] > m['pe'] else 'rise'} (forward P/E {m['forward_pe']:.1f} vs trailing {m['pe']:.1f}). Treat forecasts as opinions.")
    say(mu, "info", "A great business at a fair price beats a fair business at a great price. Decide which of the two this is before you look at the price again.")

    # ------------------------------------------------------------ verdict
    gs, qs = m["graham_score"], m["quality_score"]
    if cyclical:
        verdict = f"A cyclical. The screener's {gs}/7 + {qs}/7 flatters it — those rules were written for ordinary businesses and light up at the top of a commodity cycle. Cheap oil/metal bets can work, but the price of the commodity, not the company, decides."
    elif loss_years:
        verdict = "The record has loss years, which fails Graham outright and makes Buffett's 'consistent earning power' doubtful. Only for someone who knows why those years were exceptions."
    elif gs >= 5 and qs >= 5:
        verdict = "Cheap AND good on the numbers — the rare combination all three looked for. Now read why it is cheap: the market usually has a reason."
    elif qs >= 5:
        verdict = "A quality business at a full price. Buffett/Munger territory — worth a watchlist entry and a price alert below today's level."
    elif gs >= 5:
        verdict = "Statistically cheap but not a standout business. Graham's kind of stock: buy a basket of these, not one."
    else:
        verdict = "Neither cheap nor clearly excellent on these numbers. Pass, unless you know something the numbers don't show."

    return {"symbol": sym, "generated": int(time.time()), "facts": facts,
            "graham": g, "buffett": b, "munger": mu, "verdict": verdict,
            "note": "Numbers from Yahoo Finance (delayed; up to four fiscal years). This is a reading of the numbers in three investors' styles, not advice."}


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
    d = build(sym)
    p.write_text(json.dumps(d))
    return d
