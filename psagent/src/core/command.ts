import { type Command } from "commander";
import { exitCodeFromError } from "./errors.js";
import { printError } from "./output.js";

export function wrapAction<Args extends unknown[]>(fn: (...args: Args) => Promise<void>) {
  return (...args: Args): void => {
    void fn(...args).catch((err) => {
      printError(err);
      process.exitCode = exitCodeFromError(err);
    });
  };
}

export function commandFromArgs(args: unknown[]): Command {
  return args[args.length - 1] as Command;
}
