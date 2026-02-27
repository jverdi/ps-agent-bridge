import { readFileSync } from "node:fs";
import { Command } from "commander";
import { wrapAction, commandFromArgs } from "../core/command.js";
import { CliError } from "../core/errors.js";
import { loadOperationHelpDocs } from "../core/operation-help.js";
import { printData } from "../core/output.js";
import { buildRuntime, persistSession } from "../core/runtime.js";
import { validateOperationEnvelope } from "../core/validate-ops.js";

function formatCatalogHelpText(groups: Array<{ name: string; operations: string[] }>): string {
  const lines = ["", "Operation catalog (from docs/reference/operation-catalog.mdx):"];

  for (const group of groups) {
    if (group.operations.length === 0) {
      continue;
    }
    lines.push(`  ${group.name}:`);
    lines.push(`    ${group.operations.join(", ")}`);
  }

  lines.push("");
  lines.push("Guidance: Photoshop can switch active documents between separate CLI invocations.");
  lines.push("  Keep dependent work in one `psagent op apply` transaction and use refs.");
  lines.push("");
  lines.push("Run `psagent op <operation> --help` for operation-specific arguments and examples.");
  return lines.join("\n");
}

function formatOperationHelpText(entry: {
  aliases: string[];
  required: string;
  supportedArgs: string;
  notes: string;
  example: string;
}): string {
  const lines = ["", "Operation arguments and examples (from docs/reference/operation-arguments-and-examples.mdx):"];

  lines.push(`  Required: ${entry.required}`);
  lines.push(`  Supported args: ${entry.supportedArgs}`);
  if (entry.notes) {
    lines.push(`  Notes: ${entry.notes}`);
  }
  lines.push(`  Aliases: ${entry.aliases.length > 0 ? entry.aliases.join(", ") : "None"}`);

  if (entry.example) {
    lines.push("  Example op payload:");
    for (const line of entry.example.split(/\r?\n/u)) {
      lines.push(`    ${line}`);
    }
  }

  lines.push("");
  lines.push("Execute operations via an envelope file:");
  lines.push("  psagent op apply -f <ops.json>");

  return lines.join("\n");
}

function registerOperationHelpCommands(op: Command): void {
  const docs = loadOperationHelpDocs();
  if (!docs) {
    return;
  }

  op.addHelpText("after", formatCatalogHelpText(docs.groups));

  const orderedNames: string[] = [];
  const seen = new Set<string>();

  for (const group of docs.groups) {
    for (const operationName of group.operations) {
      if (!seen.has(operationName)) {
        orderedNames.push(operationName);
        seen.add(operationName);
      }
    }
  }

  for (const entry of docs.entries) {
    if (!seen.has(entry.name)) {
      orderedNames.push(entry.name);
      seen.add(entry.name);
    }
  }

  for (const operationName of orderedNames) {
    const entry = docs.byName.get(operationName);
    if (!entry) {
      continue;
    }

    const command = op.command(operationName, { hidden: !docs.catalogOperationNames.has(operationName) });
    command.description(`Show arguments and examples for ${operationName}`);
    command.addHelpText("after", formatOperationHelpText(entry));
    command.action((...args) => {
      const subcommand = commandFromArgs(args);
      subcommand.outputHelp();
    });
  }
}

export function registerOpCommands(program: Command): void {
  const op = program.command("op").description("Operation execution");

  op
    .command("apply")
    .description("Apply operation envelope")
    .requiredOption("-f, --file <path>", "Path to ops JSON file")
    .option("--doc <ref>", "Document ref override")
    .option("--checkpoint", "Create checkpoint before apply")
    .option("--dry-run", "Do not mutate document")
    .option("--op-delay-ms <ms>", "Delay between ops within one transaction")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const options = command.opts<{ file: string; doc?: string; checkpoint?: boolean; dryRun?: boolean; opDelayMs?: string }>();
        const runtime = buildRuntime(command);

        const source = readFileSync(options.file, "utf8");
        const parsed = JSON.parse(source) as unknown;
        const payload = validateOperationEnvelope(parsed);

        let opDelayMs: number | undefined;
        if (options.opDelayMs !== undefined) {
          const parsedDelay = Number(options.opDelayMs);
          if (!Number.isFinite(parsedDelay) || parsedDelay < 0) {
            throw new CliError("--op-delay-ms must be a non-negative number", 2);
          }
          opDelayMs = Math.max(0, Math.min(60_000, Math.trunc(parsedDelay)));
        }

        payload.doc.ref = options.doc ?? runtime.session?.activeDocument ?? payload.doc.ref;
        payload.safety = {
          ...payload.safety,
          dryRun: Boolean(payload.safety?.dryRun || options.dryRun || runtime.config.dryRun),
          ...(opDelayMs !== undefined ? { opDelayMs } : {})
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

  registerOperationHelpCommands(op);
}
