# psagent scaffold

Agent-ready Photoshop automation scaffold with:

- `psagent` CLI command tree
- Desktop adapter contract (`/rpc` bridge)
- Cloud adapter placeholder (token-gated)
- `ops.json` schema validation
- Minimal MCP-style stdio server
- Minimal UXP plugin scaffold (`photoshop-uxp-bridge/`)

## Quick start

```bash
npm install
npm run build
```

Run a local mock desktop bridge:

```bash
npm run dev -- bridge mock
```

Run the real bridge daemon (used by UXP plugin):

```bash
npm run dev -- bridge daemon
```

Automate UXP plugin reload + reconnect workflow (macOS):

```bash
npm run bridge:reload
```

Run optional dev hot-reload server for panel code changes (`index.js`, `index.html`, `manifest.json`):

```bash
npm run bridge:hotreload
```

Options:

- Uses UXP CLI plugin load flow (`@adobe-fixed-uxp/uxp-devtools-cli`) and auto-patches known parser bug locally
- Direct script usage supports flags like `--no-wait`, `--timeout 40`, `--endpoint http://127.0.0.1:43120`
- Script path: `scripts/dev/reload-psagent-bridge.sh`
- Hot-reload server path: `scripts/dev/hot-reload-server.mjs` (panel auto-reloads when watched files change)

In another shell, run commands:

```bash
npm run dev -- session start --mode desktop
npm run dev -- doc open ./sample.psd
npm run dev -- layer list
npm run dev -- op apply -f examples/ops.cleanup.sample.json --checkpoint
npm run dev -- render --format png --out ./out/mock.png
npm run dev -- doctor
npm run test:integration
```

## Command surface

```text
psagent [global flags] <subcommand>

subcommands:
  capabilities
  session start|status
  doc open|manifest
  layer list
  op apply
  render
  checkpoint list|restore
  events tail
  doctor
  bridge daemon|status|mock
  mcp-serve
```

Global flags:

- `--json`, `--plain`
- `-q/--quiet`, `-v/--verbose`
- `--timeout <ms>`
- `--config <path>`
- `--profile <name>`
- `--mode desktop|cloud`
- `-n/--dry-run`

## Config precedence

`flags > env > session > project config > user config > system defaults`

- Project config: `.psagent.json`
- User config: `~/.config/psagent/config.json` (or `--config` path)

Env vars:

- `PSAGENT_MODE`
- `PSAGENT_PROFILE`
- `PSAGENT_TIMEOUT_MS`
- `PSAGENT_PLUGIN_ENDPOINT`
- `PSAGENT_API_BASE`
- `PSAGENT_TOKEN`
- `PSAGENT_DRY_RUN`

## MCP server (scaffold)

Run:

```bash
npm run mcp
```

It exposes tools:

- `photoshop_capabilities`
- `photoshop_open_document`
- `photoshop_get_manifest`
- `photoshop_query_layers`
- `photoshop_apply_ops`
- `photoshop_render`
- `photoshop_checkpoint_restore`
- `photoshop_events_tail`

## UXP plugin scaffold

`photoshop-uxp-bridge/` includes a minimal panel plugin with:

- `globalThis.psagentBridge.health()`
- `globalThis.psagentBridge.applyOps(payload)`
- `globalThis.psagentBridge.connectBridge()`
- `globalThis.psagentBridge.disconnectBridge()`

Implemented ops in plugin scaffold:

- Full document/layer/selection/text/shape/smart-object operation surface (see [photoshop-uxp-bridge/README.md](./photoshop-uxp-bridge/README.md))
- `batchPlay` passthrough for raw Action Manager descriptors
- Agent-oriented controls in `applyOps`:
  - op-local refs (`ref` + `$ref` resolution)
  - per-op `onError` (`abort` or `continue`)
  - `safety.rollbackOnError` best-effort rollback
  - structured per-op results (`opResults`, `failures`, `refs`, `rolledBack`)
  - operation contract validation (envelope + per-op preflight checks before mutation handlers)
  - unified modal wrapper with retry + normalized Photoshop state errors

Integration tests:

- `npm run test:integration` runs CLI -> adapter -> mock bridge tests across the full planned operation list and validates success/outcome assertions.

Desktop flow:

1. Start daemon: `npm run dev -- bridge daemon`
2. Load plugin in Photoshop UXP Dev Tool
3. Open `PSAgent Bridge` panel and click `Connect Bridge`
4. Run CLI commands (`session start`, `layer list`, `op apply`, etc.)

CLI desktop adapter always targets daemon `/rpc`, and daemon forwards to connected UXP client via `/bridge/*`.
