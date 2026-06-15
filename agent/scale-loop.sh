#!/bin/bash
# Sustained discovery loop toward the target corpus size. Each round is a full
# all-category, high-concurrency discovery pass that commits+pushes its data (and
# thus deploys the site) and then exits deterministically. Rounds are SEQUENTIAL,
# so there are no git push races. A per-round `timeout` is a belt-and-suspenders
# guard in case any future regression reintroduces a hang.
#
# Usage: bash scale-loop.sh [target] [max_rounds] [concurrency]
set -u
cd "$(dirname "$0")"

TARGET="${1:-1500}"
MAX_ROUNDS="${2:-300}"
CONC="${3:-13}"
LOG=/tmp/wos-loop.log

count() { node -e "console.log(require('./data/findings.json').totalFindings||0)" 2>/dev/null || echo 0; }

echo "[loop] start $(date -u +%FT%TZ) target=$TARGET max_rounds=$MAX_ROUNDS concurrency=$CONC" | tee -a "$LOG"
for i in $(seq 1 "$MAX_ROUNDS"); do
  C=$(count)
  echo "[loop] ── round $i — current findings=$C / $TARGET ──" | tee -a "$LOG"
  if [ "$C" -ge "$TARGET" ]; then echo "[loop] TARGET REACHED ($C >= $TARGET)" | tee -a "$LOG"; break; fi
  START=$(date +%s)
  PI_RESEARCH_SKIP_HEALTHCHECK=1 PI_RESEARCH_BROWSER_HEADLESS=true \
    timeout 1200 npx tsx src/main.ts --all --concurrency "$CONC" >> "$LOG" 2>&1
  RC=$?
  echo "[loop] round $i exit=$RC dur=$(( $(date +%s) - START ))s findings=$(count)" | tee -a "$LOG"
  [ "$RC" -eq 124 ] && echo "[loop] WARNING round $i hit the 1200s timeout guard" | tee -a "$LOG"
  sleep 3
done
echo "[loop] done $(date -u +%FT%TZ) final findings=$(count)" | tee -a "$LOG"
