# Pine Script versions (for TradingView)

`auto_lines.pine` — the dashboard's "Auto lines" feature rewritten in Pine
Script v6 so it can be used inside TradingView. Same idea: swing pivots,
trendlines through them (3+ touches), horizontal support/resistance where
price turned 3+ times, unfilled gaps, trend structure and a 0-100 setup score.

Install: open TradingView → *Pine Editor* (bottom of the chart) → paste the
whole file → *Add to chart*. Free accounts can run it (limit: 2 custom
indicators per chart). Settings (pivot strength, bars to analyse, tolerance)
are in the indicator's gear icon.

Not verified inside TradingView from this machine (no account here) — if the
editor reports a line, send the message back and it gets fixed.

## 2026-09-16

- auto_lines.pine: REWRITTEN so it compiles. Pine has no comma-separated
  declarations or statements (`float a = na, b = na`, `x := 1, y := 2`) and
  arrays cannot hold tuples (`for [a, b] in array.from(...)`); every such line
  was split, the level drawing moved into a helper, the gap scan made O(n).
  Verified: compiles clean in the TradingView Pine editor (v6).
- volume_profile_poc.pine: NEW. Volume-at-price histogram over the last N bars
  with Point of Control, 70 % Value Area (VAH / VAL), grey low-volume edges,
  and a table. Verified: compiles clean in the TradingView Pine editor (v6).
