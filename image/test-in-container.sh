#!/usr/bin/env bash
# Run install.sh in an arm64 Debian container, then start the services the
# way the systemd units do and check the box answers. Tests everything but
# systemd itself, the kiosk display, CEC and GPIO.
#   ./image/test-in-container.sh            (needs Docker; ~5 min first run)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
docker run --rm --platform linux/arm64 -v "$root:/src:ro" -e SKIP_SYSTEMD=1 -e BOX_USER=box debian:bookworm bash -euc '
  apt-get update -qq && apt-get install -y -qq sudo curl >/dev/null
  /src/image/install.sh
  echo "── starting services as the units would ──"
  set -a; . /etc/box/box.env; set +a
  run() { sudo -u box -E -H bash -c "$1" >/tmp/$2.log 2>&1 & }
  run "temporal server start-dev --ip 127.0.0.1 --namespace box --db-filename /var/lib/box/temporal.db --log-level warn" temporal
  for i in $(seq 1 60); do temporal operator namespace describe -n box >/dev/null 2>&1 && break; sleep 1; done || true
  temporal operator namespace describe -n box >/dev/null 2>&1 || { echo "✗ Temporal did not start"; tail -20 /tmp/temporal.log; exit 1; }
  run "cd /opt/retro-cable-box/services/worker && /opt/retro-cable-box/node_modules/.bin/tsx src/worker.ts" worker
  run "cd /opt/retro-cable-box/services/api && /opt/retro-cable-box/node_modules/.bin/tsx src/server.ts" api
  run "cd /opt/retro-cable-box/services/mcp && /opt/retro-cable-box/node_modules/.bin/tsx src/server.ts" mcp
  for i in $(seq 1 90); do grep -q "fresh box" /tmp/worker.log 2>/dev/null && break; sleep 1; done
  sleep 25
  echo "── checks ──"
  grep -E "box-|fatal|Error" /tmp/worker.log | head -5
  curl -fsS http://127.0.0.1:8760/ | grep -o "<title>[^<]*</title>"
  curl -fsS http://127.0.0.1:8760/api/box | jq -c "{lanMcpUrl, token: (.token|length)}"
  cd /opt/retro-cable-box && sudo -u box -E -H pnpm --filter @box/api smoke 2>&1 | grep -E "✓|✗|passed|failed"
  sudo -u box -E -H MCP_TOKEN=$MCP_TOKEN pnpm --filter @box/mcp smoke 2>&1 | grep -E "✓|✗|passed|failed"
  sudo -u box -E -H /usr/local/bin/box-backup && ls /var/lib/box/backup
  curl -s -o /dev/null -w "MCP without token → %{http_code}\n" -X POST http://127.0.0.1:8750/mcp
'
