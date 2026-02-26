import { Command } from "commander";
import { wrapAction, commandFromArgs } from "../core/command.js";
import { printData } from "../core/output.js";
import { buildRuntime } from "../core/runtime.js";

export function registerRenderCommands(program: Command): void {
  program
    .command("render")
    .description("Render current document")
    .requiredOption("--format <format>", "png|jpg")
    .requiredOption("--out <path>", "Output path")
    .option("--doc <ref>", "Document ref override")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const options = command.opts<{ format: "png" | "jpg"; out: string; doc?: string }>();
        const runtime = buildRuntime(command);

        const format = options.format;
        if (format !== "png" && format !== "jpg") {
          throw new Error("Invalid --format. Expected png|jpg");
        }

        const docRef = options.doc ?? runtime.session?.activeDocument ?? "active";
        const result = await runtime.adapter.render(docRef, format, options.out);

        printData(runtime.config.outputMode, result, [
          `format=${result.format}`,
          `output=${result.output}`,
          `detail=${result.detail}`
        ]);
      })
    );
}
