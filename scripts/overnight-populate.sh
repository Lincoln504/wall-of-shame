#!/usr/bin/env bash
#
# overnight-populate.sh — drive the Wall of Shame agent toward a target corpus size.
#
# Runs DISCOVERY rounds back-to-back. Each round researches ALL categories
# (--all), grounds/verifies new findings, and (inside the agent) commits + pushes
# agent/data/findings.json — which auto-triggers the Pages deploy workflow
# (copy → re-embed → build → publish). This driver only sequences the rounds; it
# never commits anything itself.
#
# Robustness for an unattended overnight run:
#   - a round that crashes is logged and the loop continues (failure isolation);
#   - stops cleanly at the target, on a sustained plateau, or when a STOP file appears;
#   - the SDK + browser pool are torn down and rebuilt fresh each round (one process
#     per round) so a leak in one round can't compound across the night.
#
# Tunables (env): WOS_TARGET (default 1500), WOS_CONCURRENCY (5),
#                 WOS_MAX_FLAT (consecutive zero-net-add rounds before stop, 5).
# Graceful stop:  touch agent/data/STOP_LOOP
#
set -uo pipefail

export PATH="/home/ldeen/.config/nvm/versions/node/v25.8.2/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1   # repo root

TARGET="${WOS_TARGET:-1500}"
CONCURRENCY="${WOS_CONCURRENCY:-5}"
MAX_FLAT="${WOS_MAX_FLAT:-5}"
STOP_FILE="agent/data/STOP_LOOP"
LOG="agent/data/overnight.log"   # *.log is gitignored

count() { node -e "process.stdout.write(String(require('./agent/data/findings.json').findings.length))" 2>/dev/null || echo 0; }
log()   { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

rm -f "$STOP_FILE"
start_count="$(count)"
flat=0
round=0

log "════════════════════════════════════════════════════════════════"
log "overnight population START — target=$TARGET concurrency=$CONCURRENCY max_flat=$MAX_FLAT"
log "starting findings: $start_count"
log "════════════════════════════════════════════════════════════════"

while : ; do
  if [ -f "$STOP_FILE" ]; then log "STOP file present — exiting gracefully."; break; fi

  cur="$(count)"
  if [ "$cur" -ge "$TARGET" ]; then
    log "TARGET REACHED ($cur >= $TARGET) — done."; break
  fi

  round=$((round + 1))
  before="$cur"
  log "──── round $round START (have $before, want $TARGET) ────"

  if npm run start --prefix agent -- --all --concurrency "$CONCURRENCY" >> "$LOG" 2>&1; then
    log "round $round process exited cleanly"
  else
    log "round $round process exited NON-ZERO (continuing)"
  fi

  after="$(count)"
  added=$((after - before))
  log "──── round $round DONE: +$added new (total now $after) ────"

  if [ "$added" -le 0 ]; then
    flat=$((flat + 1))
    log "no net additions this round ($flat/$MAX_FLAT consecutive flat rounds)"
    if [ "$flat" -ge "$MAX_FLAT" ]; then
      log "PLATEAU: $MAX_FLAT consecutive rounds added nothing — stopping."; break
    fi
  else
    flat=0
  fi
done

final="$(count)"
log "════════════════════════════════════════════════════════════════"
log "overnight population FINISHED — $final findings (started at $start_count, +$((final - start_count)) over $round rounds)"
log "════════════════════════════════════════════════════════════════"
