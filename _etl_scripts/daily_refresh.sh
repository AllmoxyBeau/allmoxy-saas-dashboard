#!/bin/bash
# Daily Allmoxy SaaS-CFO dashboard refresh — run by launchd at 7am Mountain
# (LaunchAgent com.allmoxy.dashboard-refresh). Pulls fresh data from every live
# source (Stripe charges + Connect gross/net, HubSpot, JIRA/Harvest, Aurora),
# rebuilds all snapshots, commits, and pushes to deploy the live dashboard.
#
# launchd runs with a minimal environment, so we set PATH/HOME explicitly:
#   - node/npm live in /usr/local/bin, git in /usr/bin
#   - HOME is needed for git + ssh to find ~/.ssh (key auth verified headless)
# Output is appended to _etl_scripts/logs/daily_refresh.log (gitignored).
set -o pipefail
export HOME="/Users/beaulewis"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJ="/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard"
LOG_DIR="$PROJ/_etl_scripts/logs"
LOG="$LOG_DIR/daily_refresh.log"
mkdir -p "$LOG_DIR"

cd "$PROJ" || { echo "$(date '+%Y-%m-%d %H:%M:%S %Z'): FATAL cd failed" >> "$LOG"; exit 1; }

echo "" >> "$LOG"
echo "========== $(date '+%Y-%m-%d %H:%M:%S %Z') · daily refresh START ==========" >> "$LOG"
npm run refresh:all:deploy >> "$LOG" 2>&1
code=$?
echo "========== $(date '+%Y-%m-%d %H:%M:%S %Z') · daily refresh END (exit $code) ==========" >> "$LOG"
exit $code
