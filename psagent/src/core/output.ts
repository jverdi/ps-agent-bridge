import type { OutputMode } from "../types.js";

export function printData(mode: OutputMode, data: unknown, plainLines?: string[]): void {
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (mode === "plain") {
    if (plainLines && plainLines.length > 0) {
      process.stdout.write(`${plainLines.join("\n")}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(data)}\n`);
    return;
  }

  if (typeof data === "string") {
    process.stdout.write(`${data}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function printError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
}
