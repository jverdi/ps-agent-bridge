---
name: ps-agent-bridge
description: Use PS Agent Bridge to automate Photoshop workflows from CLI tools and coding agents.
license: MIT
compatibility: Requires Adobe Photoshop 24+, the PS Agent Bridge plugin, and Node.js 20+.
metadata:
  author: jverdi
  version: "1.0"
---

# PS Agent Bridge Skill

Use this skill when automating Photoshop document creation and manipulation, such as working with PSD files or creating layered images.

## Fast Start

Install CLI globally from npm:

```bash
npm install -g @jverdi/ps-agent-bridge
```

Install Photoshop plugin (one-time human setup):

1. Open Creative Cloud Desktop.
2. Go to `Stock & Marketplace`.
3. Search for `PS Agent Bridge` plugin and install it.
4. Open Photoshop and open the `PS Agent Bridge` panel.
5. Bridge auto-connects on launch; click `Connect Bridge` only if needed.

Start daemon for desktop mode:

```bash
psagent bridge daemon
```

## Canonical Command Surface

Use these first:

```bash
psagent session start
psagent bridge status
psagent doc manifest
psagent layer list
psagent op apply -f <ops.json> --checkpoint
psagent events tail --count 40
psagent doctor
```

## MCP

Start MCP server:

```bash
psagent mcp-serve
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
   - Re-open the `PS Agent Bridge` panel in Photoshop and click `Connect Bridge`
3. If operation fails:
   - `psagent events tail --count 80`
   - Re-run op with same payload and inspect per-op `opResults`
4. If Photoshop state errors occur:
   - Exit text edit/transform/modal dialogs in Photoshop
   - Retry once

## Working Agreement

- Prefer deterministic payloads and explicit cleanup ops in automation tests.
