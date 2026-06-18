#!/bin/bash
# Sustained discovery loop toward the target corpus size. Each round is a full
# all-category discovery pass; rounds are SEQUENTIAL (no git push races).
#
# SAFETY (after a memory-pressure freeze on 2026-06-15):
#   - Default concurrency is LOW (3). Each concurrent category spawns a camoufox
#     (Firefox) stealth browser; ~13 at once exhausted RAM on a 6-core/31GB host
#     that also runs other heavy services, thrashing swap until the machine froze.
#     Keep this small; raise only with headroom to spare.
#   - The log goes to DISK (next to this script), never /tmp — /tmp is tmpfs (RAM).
#   - A pre-round MemAvailable guard waits if free memory is low, so a round never
#     starts into a near-OOM condition.
#   - Verbose SDK debug logging stays OFF (set WOS_PI_DEBUG=1 only when diagnosing).
#
# MAINTENANCE AUDIT: every AUDIT_INTERVAL rounds (default 5), a sample audit runs
#   on the existing corpus. This catches directional failures and quote fabrications
#   in entries added by earlier rounds before standards fully stabilized. The audit
#   samples ~25 entries, scrapes them, and runs DeepSeek verification. Removals are
#   applied automatically and the result is logged. Runtime ~15-20min per audit.
#   Set AUDIT_INTERVAL=0 to disable maintenance audits.
#
# Usage: bash scale-loop.sh [target] [max_rounds] [concurrency] [min_avail_mb] [audit_interval]
set -u
cd "$(dirname "$0")"

TARGET="${1:-1500}"
MAX_ROUNDS="${2:-300}"
CONC="${3:-3}"
MIN_AVAIL_MB="${4:-6000}"   # don't start a round unless this many MB are available
AUDIT_INTERVAL="${5:-3}"    # run maintenance audit every N rounds (0 = disabled)
LOG="$(cd "$(dirname "$0")" && pwd)/scale-loop.log"   # on disk, *.log is gitignored

count() { node -e "console.log(require('./data/findings.json').totalFindings||0)" 2>/dev/null || echo 0; }
avail_mb() { awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 999999; }

echo "[loop] start $(date -u +%FT%TZ) target=$TARGET max_rounds=$MAX_ROUNDS concurrency=$CONC min_avail=${MIN_AVAIL_MB}MB audit_every=${AUDIT_INTERVAL}" | tee -a "$LOG"
for i in $(seq 1 "$MAX_ROUNDS"); do
  C=$(count)
  echo "[loop] ── round $i — current findings=$C / $TARGET ──" | tee -a "$LOG"
  if [ "$C" -ge "$TARGET" ]; then echo "[loop] TARGET REACHED ($C >= $TARGET)" | tee -a "$LOG"; break; fi

  # Memory guard: wait (up to ~5 min) for headroom before starting a browser-heavy round.
  # If memory is still too low after 5 min, SKIP the round entirely (continue outer loop).
  mem_ok=1
  waited=0
  while [ "$(avail_mb)" -lt "$MIN_AVAIL_MB" ]; do
    echo "[loop] low memory ($(avail_mb)MB < ${MIN_AVAIL_MB}MB) — waiting 30s before round $i" | tee -a "$LOG"
    sleep 30; waited=$((waited+30))
    if [ "$waited" -ge 300 ]; then
      echo "[loop] still low after 5min — SKIPPING round $i" | tee -a "$LOG"
      mem_ok=0; break
    fi
  done
  [ "$mem_ok" -eq 0 ] && continue

  BEFORE=$(count)
  START=$(date +%s)
  PI_RESEARCH_SKIP_HEALTHCHECK=1 PI_RESEARCH_BROWSER_HEADLESS=true \
    timeout 3600 npx tsx src/main.ts --all --concurrency "$CONC" --no-commit >> "$LOG" 2>&1
  RC=$?
  AFTER=$(count)
  ADDED=$(( AFTER - BEFORE ))
  echo "[loop] round $i exit=$RC dur=$(( $(date +%s) - START ))s added=$ADDED findings=$AFTER avail=$(avail_mb)MB" | tee -a "$LOG"
  [ "$RC" -eq 124 ] && echo "[loop] WARNING round $i hit the 3600s timeout guard" | tee -a "$LOG"

  # Maintenance audit: audit all entries from this round + 10% random sample of the rest.
  if [ "$AUDIT_INTERVAL" -gt 0 ] && [ $((i % AUDIT_INTERVAL)) -eq 0 ]; then
    echo "[loop] ── maintenance audit (round $i / interval $AUDIT_INTERVAL, recent=$ADDED) ──" | tee -a "$LOG"
    MSTART=$(date +%s)
    # --recent=$ADDED: always audits every entry from this round + 10% of older corpus.
    timeout 1200 npx tsx scripts/sample_audit.ts --recent="$ADDED" >> "$LOG" 2>&1
    MRC=$?
    echo "[loop] maintenance audit exit=$MRC dur=$(( $(date +%s) - MSTART ))s findings=$(count)" | tee -a "$LOG"
    [ "$MRC" -eq 124 ] && echo "[loop] WARNING maintenance audit hit 1200s timeout" | tee -a "$LOG"

    # Resolution pass: if flagged-review.json has unresolved entries, attempt resolution.
    # Still-ambiguous entries after maxResolveAttempts are removed from the corpus.
    PENDING=$(node -e "const f=require('./data/flagged-review.json'); console.log(f.flagged.filter(e=>e.resolveAttempts<(f.maxResolveAttempts||3)).length)" 2>/dev/null || echo 0)
    EXHAUSTED=$(node -e "const f=require('./data/flagged-review.json'); const max=f.maxResolveAttempts||3; console.log(f.flagged.filter(e=>e.resolveAttempts>=max).length)" 2>/dev/null || echo 0)
    if [ "$PENDING" -gt 0 ] || [ "$EXHAUSTED" -gt 0 ]; then
      echo "[loop] ── flagged resolution (pending=$PENDING exhausted=$EXHAUSTED) ──" | tee -a "$LOG"
      RSTART=$(date +%s)
      timeout 900 npx tsx scripts/resolve_flagged.ts >> "$LOG" 2>&1
      RRC=$?
      echo "[loop] resolution exit=$RRC dur=$(( $(date +%s) - RSTART ))s findings=$(count)" | tee -a "$LOG"
      [ "$RRC" -eq 124 ] && echo "[loop] WARNING resolution pass hit 900s timeout" | tee -a "$LOG"
    fi
  fi

  sleep 5
done
echo "[loop] done $(date -u +%FT%TZ) final findings=$(count)" | tee -a "$LOG"
