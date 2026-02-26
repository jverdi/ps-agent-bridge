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

## Product summary

PS Agent Bridge is a local automation stack for Photoshop that provides a stable command surface, operation payload schema, and runtime bridge between CLI workflows and Photoshop UXP APIs. Agents use the `psagent` CLI to control Photoshop documents, layers, and operations through JSON operation envelopes. The bridge daemon runs on `http://127.0.0.1:43120` and brokers calls between the CLI and a UXP plugin inside Photoshop. Key files: `.psagent.json` (project config), `~/.config/psagent/config.json` (user config), operation envelope JSON payloads. Primary CLI: `psagent` with subcommands for sessions, documents, layers, operations, rendering, checkpoints, and diagnostics. MCP server available via `psagent mcp-serve` for agent tool integration.

## When to use

Reach for this skill when:
- Automating Photoshop document and layer operations (create, rename, delete, style, export)
- Building reproducible creative workflows with deterministic operation sequences
- Managing document state with checkpoints and rollback capabilities
- Querying document structure (manifest, layers, properties)
- Exporting renders (PNG/JPG) from Photoshop programmatically
- Testing operation payloads before production use (dry-run mode)
- Integrating Photoshop automation into agent-driven workflows via MCP tools
- Debugging operation failures and validating bridge connectivity

## Quick reference

### Essential CLI commands

| Command | Purpose |
|---------|---------|
| `psagent session start [--profile <name>]` | Start a bridge session |
| `psagent bridge status` | Check daemon and UXP connection |
| `psagent doc open <path>` | Open a Photoshop document |
| `psagent layer list [--match <regex>]` | List layers in active document |
| `psagent op apply -f <ops.json> [--checkpoint] [--dry-run]` | Apply operation envelope |
| `psagent render --format png\|jpg --out <path>` | Export active document |
| `psagent checkpoint list` | List saved checkpoints |
| `psagent checkpoint restore <id>` | Restore document to checkpoint |
| `psagent doctor` | Diagnose health and connectivity |
| `psagent mcp-serve` | Start MCP server for agent tools |

### Global flags

| Flag | Purpose |
|------|---------|
| `--json` | Output JSON format |
| `--dry-run` / `-n` | Preview without mutation |
| `--checkpoint` | Create checkpoint before operation |
| `--timeout <ms>` | Override request timeout |
| `--profile <name>` | Use named configuration profile |
| `--config <path>` | Specify config file path |
| `-v, --verbose` | Verbose logging |
| `-q, --quiet` | Suppress output |

### Configuration precedence

Flags override environment variables, which override session config, which override project config (`.psagent.json`), which override user config (`~/.config/psagent/config.json`), which override defaults.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `PSAGENT_PROFILE` | Default profile name |
| `PSAGENT_TIMEOUT_MS` | Request timeout in milliseconds |
| `PSAGENT_PLUGIN_ENDPOINT` | UXP plugin endpoint (default: `http://127.0.0.1:43120`) |
| `PSAGENT_DRY_RUN` | Enable dry-run mode by default |

### Operation envelope structure

```json
{
  "transactionId": "tx-001",
  "doc": { "ref": "active" },
  "refs": {
    "hero": "layer_123"
  },
  "ops": [
    { "op": "createLayer", "name": "Draft", "ref": "draftLayer" },
    { "op": "renameLayer", "target": "$draftLayer", "name": "Draft v2" }
  ],
  "safety": {
    "dryRun": false,
    "checkpoint": false,
    "rollbackOnError": false,
    "onError": "abort"
  }
}
```

### MCP tools (for agent use)

| Tool | Purpose |
|------|---------|
| `photoshop_capabilities` | Return adapter mode and capability map |
| `photoshop_open_document` | Open document by local path or URL |
| `photoshop_get_manifest` | Return document structure and metadata |
| `photoshop_query_layers` | List layers with optional regex filter |
| `photoshop_apply_ops` | Apply operation envelope payload |
| `photoshop_render` | Export active document to PNG/JPG |
| `photoshop_checkpoint_restore` | Restore document to checkpoint by ID |
| `photoshop_events_tail` | Fetch recent adapter events |

## Decision guidance

### When to use dry-run vs. checkpoint vs. rollback

| Scenario | Use | Why |
|----------|-----|-----|
| Testing operation syntax before production | `--dry-run` | Validates schema without mutating document |
| Want to undo if operation fails | `rollbackOnError: true` | Restores document to pre-operation state on error |
| Need to save state before risky operations | `--checkpoint` | Creates named snapshot for manual restore |
| Batch operations with per-op error handling | `onError: "continue"` | Skips failed ops, continues with rest |
| Single operation must not fail | `onError: "abort"` | Stops entire transaction on first error |

### When to use abort vs. continue error policy

| Scenario | Use | Why |
|----------|-----|-----|
| All operations depend on previous success | `onError: "abort"` | Prevents cascading failures |
| Some operations are optional/independent | `onError: "continue"` | Maximizes output even if some ops fail |
| Cleanup operations must run regardless | Per-op `onError: "continue"` | Ensures deleteLayer runs even if earlier ops fail |

### When to use CLI vs. MCP server

| Scenario | Use | Why |
|----------|-----|-----|
| Direct command-line automation | `psagent` CLI | Simple, synchronous, full control |
| Agent-driven workflows | `psagent mcp-serve` | Exposes tools to agent clients via JSON-RPC |
| Integration testing | `psagent` CLI with `--json` | Structured output for assertions |
| Real-time monitoring | `psagent events tail` | Stream recent operations and errors |

## Workflow

### Typical task: Apply operations to a Photoshop document

1. **Start the bridge stack** (one-time setup):
   - Terminal A: `psagent bridge daemon` (runs on `127.0.0.1:43120`)
   - Terminal B: Reload UXP plugin in Photoshop (or use `npm run bridge:reload`)
   - Terminal C (optional): `psagent mcp-serve` if using agent tools

2. **Verify connectivity**:
   - Run `psagent bridge status` — confirm "Connected" and queue is empty
   - Run `psagent doctor` — check health, exit code 0 = OK

3. **Open a document**:
   - `psagent doc open ./path/to/file.psd`
   - Verify with `psagent layer list` to see current structure

4. **Create operation envelope**:
   - Write JSON file with `ops` array, `safety` settings, and `refs` for layer targeting
   - Use `$refName` syntax to reference layers created earlier in same transaction
   - Always set text style explicitly after `createTextLayer`

5. **Test with dry-run**:
   - `psagent op apply -f ops.json --dry-run`
   - Verify schema is valid and operation names are recognized
   - Check result for `applied: 0` (no mutations)

6. **Apply with checkpoint**:
   - `psagent op apply -f ops.json --checkpoint`
   - Inspect result for `applied`, `failed`, `aborted` counts
   - If errors, check `failures[]` array for details

7. **Validate output**:
   - `psagent layer list` to confirm layer structure
   - `psagent render --format png --out ./out.png` to export
   - `psagent doc manifest` to inspect document properties

8. **Rollback if needed**:
   - `psagent checkpoint list` to see available snapshots
   - `psagent checkpoint restore <id>` to revert to checkpoint

### Typical task: Use MCP tools from an agent

1. Start `psagent mcp-serve` in a terminal
2. Agent client connects via JSON-RPC over stdio
3. Call tools in order:
   - `photoshop_capabilities` — confirm adapter is ready
   - `photoshop_open_document` — open target file
   - `photoshop_get_manifest` — inspect structure
   - `photoshop_query_layers` — find specific layers
   - `photoshop_apply_ops` — execute operation envelope
   - `photoshop_render` — export result
   - `photoshop_checkpoint_restore` — undo if needed

## Common gotchas

- **Daemon not running**: `psagent op apply` will timeout if `psagent bridge daemon` is not running on `127.0.0.1:43120`. Always start daemon first.

- **UXP plugin disconnected**: `psagent bridge status` shows "Disconnected" if Photoshop UXP panel is not loaded. Reload plugin with `npm run bridge:reload` or manually in Photoshop.

- **Text style not applied**: Always call `setTextStyle` immediately after `createTextLayer`. Creating text without style can cause rendering issues. Include `fontSize`, `font`, and `maxWidth` to prevent overflow.

- **Layer references fail silently**: Use `$refName` syntax to reference layers created in the same transaction. If reference is wrong, operation may target wrong layer or fail. Validate with `--dry-run` first.

- **Rollback doesn't work as expected**: `rollbackOnError: true` uses best-effort history snapshot strategy. Some Photoshop actions may not be fully reversible. Test rollback behavior in dry-run before relying on it.

- **Checkpoint restore is slow**: Restoring large documents from checkpoint can take seconds. Don't call `checkpoint restore` in tight loops.

- **Schema validation errors are silent in JSON output**: Check `result.failures[]` array for validation errors. Exit code will be non-zero if schema validation fails.

- **Operation names are case-sensitive**: Use exact canonical names like `createLayer`, not `CreateLayer` or `create_layer`. Alias forms (e.g., `layer.rename`) map to canonical names.

- **Timeout on slow operations**: Large document operations may exceed default timeout. Use `--timeout <ms>` to increase limit for batch operations.

- **Dry-run still requires valid document**: `--dry-run` validates schema but still needs an open document. Session must be active.

## Verification checklist

Before submitting work with PS Agent Bridge:

- [ ] Bridge daemon is running on `127.0.0.1:43120` (verify with `psagent bridge status`)
- [ ] UXP plugin is connected (status shows "Connected", not "Disconnected")
- [ ] Document is open (`psagent doc open` succeeded, `psagent layer list` returns layers)
- [ ] Operation envelope JSON is valid (test with `--dry-run` first)
- [ ] All layer references use correct `$refName` syntax
- [ ] Text operations include explicit `setTextStyle` with `fontSize` and `font`
- [ ] Error policy is set correctly (`onError: "abort"` or `"continue"` as needed)
- [ ] Checkpoint is created before risky operations (`--checkpoint` flag)
- [ ] Result payload shows expected `applied` count (not `failed` or `aborted`)
- [ ] Cleanup operations (e.g., `deleteLayer`) are included to remove temporary layers
- [ ] Output is validated (render exported, manifest checked, layers verified)
- [ ] Exit code is 0 for success, non-zero for errors

## Resources

- **Comprehensive navigation**: https://ps-agent-bridge.jaredverdi.com/llms.txt — full page-by-page documentation index
- **CLI reference**: https://ps-agent-bridge.jaredverdi.com/reference/cli-reference — all commands, flags, and exit codes
- **Operation envelope**: https://ps-agent-bridge.jaredverdi.com/reference/operation-envelope — payload schema, refs, safety controls, error handling
- **Operation arguments and examples**: https://ps-agent-bridge.jaredverdi.com/reference/operation-arguments-and-examples — operation parameters and real payload examples
- **Real-world workflows**: https://ps-agent-bridge.jaredverdi.com/guides/real-world-workflows — patterns for agent-driven creative automation


> For additional documentation and navigation, see: https://ps-agent-bridge.jaredverdi.com/llms.txt
