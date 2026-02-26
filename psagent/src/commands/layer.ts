import { Command } from "commander";
import { wrapAction, commandFromArgs } from "../core/command.js";
import { printData } from "../core/output.js";
import { buildRuntime } from "../core/runtime.js";

export function registerLayerCommands(program: Command): void {
  const layer = program.command("layer").description("Layer operations");

  layer
    .command("list")
    .description("List layers")
    .option("--match <regex>", "Optional regex filter")
    .option("--doc <ref>", "Document ref, default active")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const options = command.opts<{ match?: string; doc?: string }>();
        const runtime = buildRuntime(command);

        const docRef = options.doc ?? runtime.session?.activeDocument ?? "active";
        const result = await runtime.adapter.listLayers(docRef, options.match);

        const plainLines = result.layers.map((layerItem) => `${layerItem.id}\t${layerItem.type}\t${layerItem.name}`);
        printData(runtime.config.outputMode, { docRef, layers: result.layers }, plainLines);
      })
    );
}
