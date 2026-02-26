import { Command } from "commander";
import { wrapAction, commandFromArgs } from "../core/command.js";
import { CliError } from "../core/errors.js";
import { printData } from "../core/output.js";
import { buildRuntime, persistSession } from "../core/runtime.js";

export function registerDocCommands(program: Command): void {
  const doc = program.command("doc").description("Document operations");

  doc
    .command("open")
    .description("Open a local PSD path or remote URL")
    .argument("<input>", "Path or URL")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const input = args[0] as string;
        const runtime = buildRuntime(command);

        const result = await runtime.adapter.openDocument(input);

        const updatedSession = persistSession({
          mode: runtime.config.mode,
          profile: runtime.config.profile,
          startedAt: runtime.session?.startedAt ?? new Date().toISOString(),
          activeDocument: result.docRef,
          checkpoints: runtime.session?.checkpoints ?? []
        });

        printData(runtime.config.outputMode, { result, session: updatedSession }, [
          `docRef=${result.docRef}`,
          `detail=${result.detail}`
        ]);
      })
    );

  doc
    .command("manifest")
    .description("Get document manifest")
    .option("--doc <ref>", "Document ref, default active")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const options = command.opts<{ doc?: string }>();
        const runtime = buildRuntime(command);

        const docRef = options.doc ?? runtime.session?.activeDocument ?? "active";
        if (!docRef) {
          throw new CliError("No document ref available", 2);
        }

        const result = await runtime.adapter.getManifest(docRef);

        printData(runtime.config.outputMode, result, [
          `docRef=${result.docRef}`,
          `layers=${result.layers.length}`,
          ...(result.width && result.height ? [`size=${result.width}x${result.height}`] : [])
        ]);
      })
    );
}
