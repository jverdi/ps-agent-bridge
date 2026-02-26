---
name: ps-agent-bridge
description: Use PS Agent Bridge for efficient Photoshop automation with the accompanying Photoshop CLI and UXP plugins
metadata:
  short-description: Photoshop automation via plugin and CLI
---

# PS Agent Bridge Skill

Use this skill when automating Photoshop document creation and manipulation, such as working with PSD files or creating layered images.

## Fast Start

From repo root:

```bash
npm install
npm run build
npm run skill:install
```

For Photoshop desktop mode:

```bash
npm run dev -- bridge daemon
npm run bridge:reload
```

If you want global `psagent` command access:

```bash
npm link
```

## Canonical Command Surface

Use these first:

```bash
psagent session start --mode desktop
psagent bridge status
psagent doc manifest
psagent layer list
psagent op apply -f <ops.json> --checkpoint
psagent events tail --count 40
psagent doctor
```

When global `psagent` is not linked yet, run via:

```bash
npm run dev -- <subcommand...>
```

## MCP

Start MCP server:

```bash
psagent mcp-serve
```

or:

```bash
npm run mcp
```

Main tools:

- `photoshop_capabilities`
- `photoshop_open_document`
- `photoshop_get_manifest`
- `photoshop_query_layers`
- `photoshop_apply_ops`
- `photoshop_render`
- `photoshop_checkpoint_restore`
- `photoshop_events_tail`

## Operation Envelope

- See https://ps-agent-bridge.jaredverdi.com/reference/operation-catalog for available operations

## Additional Operation Envelope Rules

- Always include `transactionId`, `doc`, and non-empty `ops[]`.
- Prefer `--checkpoint` for mutating tests.
- Use per-op `onError` only as `"abort"` or `"continue"`.
- Use refs (`ref`, `refId`, `as`) and resolve with `$name`/`$name.path`.
- Include cleanup ops (`deleteLayer`, `closeDocument`) in test payloads.

## Failure Triage

1. Check bridge connectivity:
   - `psagent bridge status`
2. If disconnected:
   - Ensure daemon running (`psagent bridge daemon`)
   - Reload plugin (`npm run bridge:reload`)
3. If operation fails:
   - `psagent events tail --count 80`
   - Re-run op with same payload and inspect per-op `opResults`
4. If Photoshop state errors occur:
   - Exit text edit/transform/modal dialogs in Photoshop
   - Retry once

## Working Agreement

- After UXP plugin code/manifest changes, run `npm run bridge:reload` before Photoshop tests.
- Prefer deterministic payloads under `examples/tests/ops` for repeatability.
- Use `npm run test:integration` before handing off structural CLI/bridge changes.
