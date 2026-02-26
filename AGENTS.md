# AGENTS.md

## Bridge Reload Gate

- After any change that requires reloading the Photoshop UXP bridge/plugin, run `npm run bridge:reload` automatically.
- Do not ask the user to manually reload/confirm first unless automated reload fails.
- Run bridge/Photoshop tests after automated reload reports success.

## Significant Change Validation Gate (Bridge/CLI)

- For every significant change to `photoshop-uxp-bridge/*` or `psagent/*`, run this sequence before handoff:
  1) `npm run check`
  2) `npm run test:integration` (mock integration suite)
  3) `npm run bridge:reload` (real plugin reload + reconnect)
  4) `npm run verify:photoshop-live` (real Photoshop: hot-reload + live integration assertions)
- Treat failures in step 4 as release blockers for bridge/CLI changes.

## Mintlify Docs Dev

- Do not run plain `mint dev` under Node 25+; Mintlify exits with a Node-version error or can appear to hang while preparing preview.
- Run docs from `docs/` with Node 22 explicitly:
  - `cd [REPO_ROOT]/docs && npx -y node@22 "$(command -v mint)" dev --no-open`
- If you need background mode:
  - `cd [REPO_ROOT]/docs && nohup npx -y node@22 "$(command -v mint)" dev --no-open > /tmp/ps-agent-bridge-mint-dev.log 2>&1 &`
- Before merging docs changes, run:
  - `npm run docs:validate`
