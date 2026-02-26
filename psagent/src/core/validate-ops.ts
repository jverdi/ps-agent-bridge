import AjvImport from "ajv";
import type { OperationEnvelope } from "../types.js";
import { operationEnvelopeSchema } from "./op-schema.js";

const AjvCtor = (AjvImport as unknown as { default?: new (...args: any[]) => any }).default ?? (AjvImport as any);
const ajv = new AjvCtor({ allErrors: true, strict: false });
const validate = ajv.compile(operationEnvelopeSchema);

export function validateOperationEnvelope(input: unknown): OperationEnvelope {
  const valid = validate(input);
  if (!valid) {
    const details = (validate.errors ?? [])
      .map((e: { instancePath?: string; message?: string }) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
      .join("; ");
    throw new Error(`Invalid operations payload: ${details}`);
  }
  return input as OperationEnvelope;
}
