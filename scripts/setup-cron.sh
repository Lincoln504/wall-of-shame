#!/usr/bin/env bash
# Sets up a weekly local cron job to run the wall-of-shame agent.
# Usage: bash scripts/setup-cron.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
AGENT_DIR="$REPO_ROOT/agent"
LOG_FILE="$REPO_ROOT/agent/data/cron.log"

# Verify prereqs
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found"; exit 1; }
command -v npx  >/dev/null 2>&1 || { echo "ERROR: npx not found"; exit 1; }

CRON_CMD="cd \"$AGENT_DIR\" && npx tsx src/main.ts >> \"$LOG_FILE\" 2>&1"
CRON_LINE="0 8 * * 1 $CRON_CMD"

echo "Adding cron entry:"
echo "  $CRON_LINE"
echo ""

# Add to crontab if not already present
CURRENT=$(crontab -l 2>/dev/null || echo "")
if echo "$CURRENT" | grep -qF "wall-of-shame"; then
  echo "A wall-of-shame cron entry already exists. Edit with: crontab -e"
else
  (echo "$CURRENT"; echo "# wall-of-shame weekly research agent"; echo "$CRON_LINE") | crontab -
  echo "Cron job added — runs every Monday at 08:00."
fi

echo ""
echo "Interactive menu: cd $AGENT_DIR && npx tsx src/cli.ts"
echo "To run manually:  cd $AGENT_DIR && npx tsx src/main.ts"
echo "To dry run:       cd $AGENT_DIR && npx tsx src/main.ts --dry-run"
echo "Cron log:         $LOG_FILE"
