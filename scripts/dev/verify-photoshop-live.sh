#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOT_RELOAD_PORT="${PSAGENT_HOT_RELOAD_PORT:-43121}"
HOT_RELOAD_TIMEOUT_SEC="${PSAGENT_HOT_RELOAD_TIMEOUT_SEC:-45}"
LOG_FILE="${PSAGENT_HOT_RELOAD_LOG:-/tmp/cccli-bridge-hotreload-verify.log}"

cd "${REPO_ROOT}"

json_eval() {
  local json="$1"
  local expr="$2"
  node -e "const j=JSON.parse(process.argv[1]); const f=new Function('j', 'return (' + process.argv[2] + ');'); const out=f(j); if (out===undefined) process.exit(2); process.stdout.write(String(out));" "$json" "$expr"
}

status_json="$(npm run -s dev -- bridge status --json)"
active_connected="$(json_eval "$status_json" "j.activeConnected")"
active_client_before="$(json_eval "$status_json" "j.activeClientId || ''")"

if [[ "${active_connected}" != "true" ]]; then
  echo "Bridge is not connected. Start daemon and run bridge reload first." >&2
  exit 1
fi

if [[ -z "${active_client_before}" ]]; then
  echo "Bridge status did not return activeClientId." >&2
  exit 1
fi

echo "bridge-connected client=${active_client_before}"

node scripts/dev/hot-reload-server.mjs --port "${HOT_RELOAD_PORT}" >"${LOG_FILE}" 2>&1 &
hotreload_pid="$!"
cleanup() {
  kill "${hotreload_pid}" >/dev/null 2>&1 || true
  wait "${hotreload_pid}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ready="false"
for _ in $(seq 1 20); do
  if curl -fsS --max-time 1 "http://127.0.0.1:${HOT_RELOAD_PORT}/version" >/dev/null 2>&1; then
    ready="true"
    break
  fi
  sleep 0.5
done

if [[ "${ready}" != "true" ]]; then
  echo "Hot-reload server did not become ready on port ${HOT_RELOAD_PORT}" >&2
  tail -n 80 "${LOG_FILE}" >&2 || true
  exit 1
fi

bump_json="$(curl -fsS -X POST "http://127.0.0.1:${HOT_RELOAD_PORT}/bump")"
bump_version="$(json_eval "$bump_json" "j.version")"
echo "hotreload-bump version=${bump_version}"

active_client_after=""
for _ in $(seq 1 "${HOT_RELOAD_TIMEOUT_SEC}"); do
  sleep 1
  loop_status="$(npm run -s dev -- bridge status --json)"
  candidate="$(json_eval "$loop_status" "j.activeClientId || ''")"
  if [[ -n "${candidate}" && "${candidate}" != "${active_client_before}" ]]; then
    active_client_after="${candidate}"
    break
  fi
done

if [[ -z "${active_client_after}" ]]; then
  echo "Hot reload check failed: bridge client id did not change after bump." >&2
  exit 1
fi

echo "hotreload-ok client=${active_client_after}"

happy_payload="$(mktemp)"
cat >"${happy_payload}" <<'JSON'
{
  "transactionId": "live-ps-integration-001",
  "doc": { "ref": "active" },
  "ops": [
    { "op": "createDocument", "name": "Live Integration", "width": 900, "height": 900, "resolution": 72, "ref": "docA" },
    { "op": "createTextLayer", "name": "Title", "text": "Integration", "position": { "x": 120, "y": 160 }, "fontSize": 64, "ref": "title" },
    { "op": "setTextStyle", "target": "$title", "fontName": "Arial-BoldMT", "fontSize": 80, "maxWidth": 760 },
    { "op": "createLayer", "name": "TempLayer", "ref": "temp" },
    { "op": "setLayerProps", "target": "$temp", "opacity": 50, "visible": true },
    { "op": "deleteLayer", "target": "$temp" },
    { "op": "createShapeLayer", "name": "Badge", "x": 32, "y": 32, "width": 120, "height": 120, "fill": "#ff6600", "ref": "badge" },
    { "op": "deleteLayer", "target": "$badge" },
    { "op": "closeDocument", "save": false }
  ],
  "safety": {
    "dryRun": false,
    "checkpoint": true,
    "rollbackOnError": false,
    "onError": "abort"
  }
}
JSON

happy_result="$(npm run -s dev -- op apply -f "${happy_payload}" --json)"
happy_applied="$(json_eval "$happy_result" "j.result.applied")"
happy_failed="$(json_eval "$happy_result" "j.result.failed")"
happy_aborted="$(json_eval "$happy_result" "j.result.aborted")"

if [[ "${happy_applied}" != "9" || "${happy_failed}" != "0" || "${happy_aborted}" != "false" ]]; then
  echo "Live happy-path integration failed expectations." >&2
  echo "${happy_result}" >&2
  exit 1
fi
echo "live-integration-happy ok applied=${happy_applied} failed=${happy_failed}"

validation_payload="$(mktemp)"
cat >"${validation_payload}" <<'JSON'
{
  "transactionId": "live-ps-validation-001",
  "doc": { "ref": "active" },
  "ops": [
    { "op": "createDocument", "name": "Live Validation", "width": 640, "height": 640, "resolution": 72, "ref": "docA" },
    { "op": "createTextLayer", "name": "Title", "text": "Validation", "ref": "title" },
    { "op": "setTextStyle", "target": "$title", "onError": "continue" },
    { "op": "closeDocument", "save": false }
  ],
  "safety": {
    "dryRun": false,
    "onError": "abort"
  }
}
JSON

validation_result="$(npm run -s dev -- op apply -f "${validation_payload}" --json)"
validation_applied="$(json_eval "$validation_result" "j.result.applied")"
validation_failed="$(json_eval "$validation_result" "j.result.failed")"
validation_aborted="$(json_eval "$validation_result" "j.result.aborted")"
validation_msg="$(json_eval "$validation_result" "(j.result.opResults.find(r => r.status === 'failed') || {}).error?.message || ''")"

if [[ "${validation_applied}" != "3" || "${validation_failed}" != "1" || "${validation_aborted}" != "false" ]]; then
  echo "Live validation-path integration failed expectations." >&2
  echo "${validation_result}" >&2
  exit 1
fi

if [[ "${validation_msg}" != *"setTextStyle requires at least one supported field"* ]]; then
  echo "Expected setTextStyle preflight validation message not found." >&2
  echo "${validation_result}" >&2
  exit 1
fi
echo "live-integration-validation ok failed=${validation_failed}"

rm -f "${happy_payload}" "${validation_payload}"
echo "verify-photoshop-live=ok"
