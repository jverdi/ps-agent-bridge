import { readFileSync } from "node:fs";
import { Command } from "commander";
import { wrapAction, commandFromArgs } from "../core/command.js";
import { CliError } from "../core/errors.js";
import { printData } from "../core/output.js";
import { buildRuntime, persistSession } from "../core/runtime.js";
import { validateOperationEnvelope } from "../core/validate-ops.js";

export function registerOpCommands(program: Command): void {
  const op = program.command("op").description("Operation execution");

  op
    .command("apply")
    .description("Apply operation envelope")
    .requiredOption("-f, --file <path>", "Path to ops JSON file")
    .option("--doc <ref>", "Document ref override")
    .option("--checkpoint", "Create checkpoint before apply")
    .option("--dry-run", "Do not mutate document")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const options = command.opts<{ file: string; doc?: string; checkpoint?: boolean; dryRun?: boolean }>();
        const runtime = buildRuntime(command);

        const source = readFileSync(options.file, "utf8");
        const parsed = JSON.parse(source) as unknown;
        const payload = validateOperationEnvelope(parsed);

        payload.doc.ref = options.doc ?? runtime.session?.activeDocument ?? payload.doc.ref;
        payload.safety = {
          ...payload.safety,
          dryRun: Boolean(payload.safety?.dryRun || options.dryRun || runtime.config.dryRun)
        };

        let checkpointId: string | undefined;
        if (options.checkpoint) {
          if (!runtime.adapter.createCheckpoint) {
            throw new CliError(`Checkpoints are not supported for mode=${runtime.config.mode}`, 8);
          }
          const created = await runtime.adapter.createCheckpoint(payload.doc.ref, `tx:${payload.transactionId}`);
          checkpointId = created.id;

          const current = runtime.session;
          persistSession({
            mode: runtime.config.mode,
            profile: runtime.config.profile,
            startedAt: current?.startedAt ?? new Date().toISOString(),
            activeDocument: payload.doc.ref,
            checkpoints: [...(current?.checkpoints ?? []), created]
          });
        }

        const result = await runtime.adapter.applyOperations(payload);

        printData(runtime.config.outputMode, { result, checkpointId }, [
          `transactionId=${result.transactionId}`,
          `applied=${result.applied}`,
          `dryRun=${String(result.dryRun)}`,
          ...(checkpointId ? [`checkpointId=${checkpointId}`] : []),
          `detail=${result.detail}`
        ]);
      })
    );
}
