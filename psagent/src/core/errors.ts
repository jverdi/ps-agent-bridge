export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function exitCodeFromError(err: unknown): number {
  if (err instanceof CliError) {
    return err.exitCode;
  }
  return 1;
}
