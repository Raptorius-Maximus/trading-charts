#!/usr/bin/env bash
#
# Supervised launcher for the trading dashboard backend.
#
# Binds 0.0.0.0:8850 ONLY -- never touch 8787/8790, those belong to the
# poker service running on this same host. If the backend process dies
# for any reason it is restarted after a short pause, and every start/
# stop/crash is logged to ./service.log with a timestamp.
#
# PID files for clean, exact-PID shutdown (no pkill/killall):
#   ./run.pid      -- this supervisor loop's own PID
#   ./uvicorn.pid  -- the currently-running backend process's PID
#
# To stop everything cleanly:
#   kill "$(cat run.pid)"       # stop the restart loop first
#   kill "$(cat uvicorn.pid)"   # then stop the running backend

set -uo pipefail
cd "$(dirname "$0")"

PORT=8850
LOG="./service.log"
RUN_PIDFILE="./run.pid"
CHILD_PIDFILE="./uvicorn.pid"

echo "$$" > "$RUN_PIDFILE"
echo "$(date -Is) run.sh supervisor started (pid $$)" >> "$LOG"

while true; do
  echo "$(date -Is) starting backend on 0.0.0.0:${PORT}" >> "$LOG"
  ./.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port "$PORT" >> "$LOG" 2>&1 &
  child=$!
  echo "$child" > "$CHILD_PIDFILE"
  wait "$child"
  code=$?
  echo "$(date -Is) backend (pid $child) exited with code $code; restarting in 2s" >> "$LOG"
  rm -f "$CHILD_PIDFILE"
  sleep 2
done
