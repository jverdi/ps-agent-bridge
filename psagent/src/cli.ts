#!/usr/bin/env node
import { Command } from "commander";
import { registerCapabilitiesCommand } from "./commands/capabilities.js";
import { registerCheckpointCommands } from "./commands/checkpoint.js";
import { registerDocCommands } from "./commands/doc.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerEventsCommands } from "./commands/events.js";
import { registerLayerCommands } from "./commands/layer.js";
import { registerOpCommands } from "./commands/op.js";
import { registerRenderCommands } from "./commands/render.js";
import { registerSessionCommands } from "./commands/session.js";
import { wrapAction } from "./core/command.js";
import { printData } from "./core/output.js";
import { readCliVersion } from "./core/version.js";
import { buildRuntimeFromOptions } from "./core/runtime.js";
import { startMockBridge } from "./bridge/mock-server.js";
import { startBridgeDaemon } from "./bridge/daemon.js";

const program = new Command();

program
  .name("psagent")
  .description("Agent Bridge for Photoshop")
  .version(readCliVersion())
  .showHelpAfterError()
  .option("--json", "JSON output")
  .option("--plain", "Plain line-based output")
  .option("-q, --quiet", "Minimal output")
  .option("-v, --verbose", "Verbose diagnostics")
  .option("--no-color", "Disable ANSI colors")
  .option("--no-input", "Disable interactive prompts")
  .option("--timeout <ms>", "Request timeout in ms")
  .option("--config <path>", "User config path")
  .option("--profile <name>", "Profile name")
  .option("-n, --dry-run", "Dry-run operations");

registerCapabilitiesCommand(program);
registerSessionCommands(program);
registerDocCommands(program);
registerLayerCommands(program);
registerOpCommands(program);
registerRenderCommands(program);
registerCheckpointCommands(program);
registerEventsCommands(program);
registerDoctorCommand(program);

const bridge = program.command("bridge").description("Bridge utilities");

bridge
  .command("daemon")
  .description("Run bridge daemon for Photoshop UXP client")
  .option("--port <port>", "Port to bind", "43120")
  .action(
    wrapAction(async (...args) => {
      const command = args[args.length - 1] as Command;
      const options = command.opts<{ port: string }>();
      const port = Number.parseInt(options.port, 10);
      if (!Number.isFinite(port)) {
        throw new Error("Invalid --port value");
      }
      startBridgeDaemon(port);
    })
  );

bridge
  .command("status")
  .description("Get bridge daemon status")
  .action(
    wrapAction(async () => {
      const runtime = buildRuntimeFromOptions({});
      const endpoint = runtime.config.pluginEndpoint.replace(/\/$/, "");
      const response = await fetch(`${endpoint}/bridge/status`);
      if (!response.ok) {
        throw new Error(`Bridge status failed: HTTP ${response.status}`);
      }
      const payload = (await response.json()) as unknown;
      printData(runtime.config.outputMode, payload);
    })
  );

bridge
  .command("mock")
  .description("Run local mock desktop bridge for development")
  .option("--port <port>", "Port to bind", "43120")
  .action(
    wrapAction(async (...args) => {
      const command = args[args.length - 1] as Command;
      const options = command.opts<{ port: string }>();
      const port = Number.parseInt(options.port, 10);
      if (!Number.isFinite(port)) {
        throw new Error("Invalid --port value");
      }
      startMockBridge(port);
    })
  );

program
  .command("mcp-serve")
  .description("Run minimal MCP JSON-RPC server over stdio")
  .action(
    wrapAction(async () => {
      await import("./mcp/server.js");
    })
  );

await program.parseAsync(process.argv);
