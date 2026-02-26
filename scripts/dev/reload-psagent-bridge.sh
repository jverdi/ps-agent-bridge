#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

wait_for_connection="true"
timeout_seconds=25
endpoint="${PSAGENT_PLUGIN_ENDPOINT:-http://127.0.0.1:43120}"
plugin_id="${PSAGENT_PLUGIN_ID:-com.psagent.bridge.v2}"
manifest_path="$(cd "${SCRIPT_DIR}/../../photoshop-uxp-bridge" && pwd)/manifest.json"
service_port="${UXP_SERVICE_PORT:-14001}"
target_app="${UXP_TARGET_APP:-PS}"
uxp_cli_pkg="${UXP_CLI_PACKAGE:-@adobe-fixed-uxp/uxp-devtools-cli@1.6.6}"
uxp_cli_workdir="${UXP_CLI_WORKDIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)/.cache/uxp-cli-fixed}"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --apps <id>         UXP app id to load plugin into (default: ${target_app})
  --service-port <n>  UXP service port (default: ${service_port})
  --no-wait           Do not wait for bridge status activeConnected=true
  --timeout <sec>     Seconds to wait for active bridge connection (default: 25)
  --endpoint <url>    Bridge daemon endpoint (default: ${endpoint})
  --manifest <path>   Path to plugin manifest.json (default: ${manifest_path})
  --plugin-id <id>    Plugin id in UXP DevTools (default: ${plugin_id})
  --uxp-pkg <pkg>     CLI npm package to use (default: ${uxp_cli_pkg})
  --uxp-workdir <p>   Working directory for cached CLI install (default: ${uxp_cli_workdir})
  -h, --help          Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apps)
      target_app="${2:-}"
      if [[ -z "$target_app" ]]; then
        echo "Missing value for --apps" >&2
        exit 2
      fi
      shift 2
      ;;
    --service-port)
      service_port="${2:-}"
      if [[ -z "$service_port" ]]; then
        echo "Missing value for --service-port" >&2
        exit 2
      fi
      shift 2
      ;;
    --uxp-pkg)
      uxp_cli_pkg="${2:-}"
      if [[ -z "$uxp_cli_pkg" ]]; then
        echo "Missing value for --uxp-pkg" >&2
        exit 2
      fi
      shift 2
      ;;
    --uxp-workdir)
      uxp_cli_workdir="${2:-}"
      if [[ -z "$uxp_cli_workdir" ]]; then
        echo "Missing value for --uxp-workdir" >&2
        exit 2
      fi
      shift 2
      ;;
    --no-wait)
      wait_for_connection="false"
      shift
      ;;
    --timeout)
      timeout_seconds="${2:-}"
      if [[ -z "$timeout_seconds" ]]; then
        echo "Missing value for --timeout" >&2
        exit 2
      fi
      shift 2
      ;;
    --endpoint)
      endpoint="${2:-}"
      if [[ -z "$endpoint" ]]; then
        echo "Missing value for --endpoint" >&2
        exit 2
      fi
      shift 2
      ;;
    --manifest)
      manifest_path="${2:-}"
      if [[ -z "$manifest_path" ]]; then
        echo "Missing value for --manifest" >&2
        exit 2
      fi
      shift 2
      ;;
    --plugin-id)
      plugin_id="${2:-}"
      if [[ -z "$plugin_id" ]]; then
        echo "Missing value for --plugin-id" >&2
        exit 2
      fi
      shift 2
      ;;
    --all|--selected|--reinstall)
      # Kept for backwards compatibility; no-op in CLI-first flow.
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$manifest_path" ]]; then
  echo "Manifest not found: $manifest_path" >&2
  exit 1
fi

mkdir -p "$uxp_cli_workdir"

if [[ ! -x "$uxp_cli_workdir/node_modules/.bin/uxp" ]]; then
  echo "Installing UXP CLI in ${uxp_cli_workdir}..."
  (
    cd "$uxp_cli_workdir"
    if [[ ! -f package.json ]]; then
      npm init -y >/dev/null
    fi
    npm i --no-save "$uxp_cli_pkg" >/dev/null
  )
fi

uxp_bin="$uxp_cli_workdir/node_modules/.bin/uxp"
tool_js="$uxp_cli_workdir/node_modules/@adobe-fixed-uxp/uxp-devtools-cli/dist/cli/utils/Tool.js"

if [[ ! -f "$uxp_bin" ]]; then
  echo "UXP CLI binary not found at $uxp_bin" >&2
  exit 1
fi

if [[ -f "$tool_js" ]]; then
  node - "$tool_js" <<'NODE'
const fs = require("fs");
const target = process.argv[2];
let source = fs.readFileSync(target, "utf8");

if (source.includes("const parsedResult = yargsInstance.help().recommendCommands().parse();")) {
  process.exit(0);
}

const oldBlock = `const params = yargsInstance.help().recommendCommands().argv;
        const cmds = params._;
        if (!cmds.length) {
            yargsInstance.showHelp();
            return;
        }
        this._currentCommand = cmds.join(' ');`;

const newBlock = `const parsedResult = yargsInstance.help().recommendCommands().parse();
        const parsedPromise = parsedResult && typeof parsedResult.then === 'function' ? parsedResult : Promise.resolve(parsedResult);
        const cmds = args.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
        if (!cmds.length) {
            yargsInstance.showHelp();
            return;
        }
        this._currentCommand = cmds.join(' ');
        parsedPromise.catch(() => {
            process.exitCode = 1;
        });`;

if (!source.includes(oldBlock)) {
  console.error("Could not patch Tool.js command parser block.");
  process.exit(2);
}

source = source.replace(oldBlock, newBlock);
fs.writeFileSync(target, source);
NODE
fi

echo "Loading PSAgent bridge plugin via UXP CLI (app=${target_app}, id=${plugin_id})..."

service_output="$("$uxp_bin" service start --port "$service_port" 2>&1)" || service_exit=$?
service_exit="${service_exit:-0}"
if [[ "$service_exit" -ne 0 ]]; then
  if [[ "$service_output" != *"port ${service_port} is occupied"* ]]; then
    echo "$service_output" >&2
    exit "$service_exit"
  fi
fi

load_output="$("$uxp_bin" plugin load --manifest "$manifest_path" --apps "$target_app" 2>&1)" || load_exit=$?
load_exit="${load_exit:-0}"
echo "$load_output"
if [[ "$load_exit" -ne 0 ]]; then
  exit "$load_exit"
fi

if [[ "$wait_for_connection" != "true" ]]; then
  exit 0
fi

status_url="${endpoint%/}/bridge/status"
deadline=$((SECONDS + timeout_seconds))

echo "Waiting for active bridge connection at ${status_url} ..."
while (( SECONDS < deadline )); do
  if status_json="$(curl -fsS --max-time 1 "$status_url" 2>/dev/null)"; then
    if printf '%s' "$status_json" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw);
    process.exit(payload.activeConnected ? 0 : 1);
  } catch {
    process.exit(2);
  }
});
'; then
      echo "Bridge is connected."
      exit 0
    fi
  fi
  sleep 1
done

echo "Timed out waiting for bridge connection after ${timeout_seconds}s." >&2
echo "Tip: ensure bridge daemon is running and PSAgent Bridge panel is visible in Photoshop." >&2
exit 3
