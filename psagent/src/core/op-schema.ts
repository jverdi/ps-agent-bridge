import { GENERATED_OPERATION_ENTRIES } from "./operation-help.generated.js";

const refNamePattern = "^[A-Za-z_][A-Za-z0-9_-]*$";

const operationControlProperties = {
  ref: { type: "string", pattern: refNamePattern },
  refId: { type: "string", pattern: refNamePattern },
  as: { type: "string", pattern: refNamePattern },
  outputRef: { type: "string", pattern: refNamePattern },
  storeAs: { type: "string", pattern: refNamePattern },
  idRef: { type: "string", pattern: refNamePattern },
  onError: { type: "string", enum: ["abort", "continue"] }
} as const;

const genericOperationProperties = {
  ...operationControlProperties
} as const;

function collectOperationNames(): string[] {
  const names = new Set<string>();

  for (const entry of GENERATED_OPERATION_ENTRIES) {
    for (const candidate of [entry.name, ...entry.aliases]) {
      if (typeof candidate !== "string") {
        continue;
      }
      const normalized = candidate.trim();
      if (!normalized) {
        continue;
      }
      names.add(normalized);
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

function looseOperationSchema(opName: string) {
  return {
    type: "object",
    additionalProperties: true,
    required: ["op"],
    properties: {
      ...genericOperationProperties,
      op: { const: opName }
    }
  };
}

const knownOperationNames = collectOperationNames();

const operationsSchema =
  knownOperationNames.length > 0
    ? knownOperationNames.map((name) => looseOperationSchema(name))
    : [
        {
          type: "object",
          additionalProperties: true,
          required: ["op"],
          properties: {
            ...genericOperationProperties,
            op: { type: "string", minLength: 1 }
          }
        }
      ];

export const operationEnvelopeSchema = {
  $id: "https://psagent.dev/schemas/operation-envelope.json",
  type: "object",
  additionalProperties: false,
  required: ["transactionId", "doc", "ops"],
  properties: {
    transactionId: {
      type: "string",
      minLength: 1
    },
    doc: {
      type: "object",
      additionalProperties: false,
      required: ["ref"],
      properties: {
        ref: {
          type: "string",
          minLength: 1
        }
      }
    },
    refs: {
      type: "object",
      propertyNames: {
        pattern: refNamePattern
      },
      additionalProperties: {
        type: "string",
        minLength: 1
      }
    },
    ops: {
      type: "array",
      minItems: 1,
      items: {
        oneOf: operationsSchema
      }
    },
    safety: {
      type: "object",
      additionalProperties: false,
      properties: {
        dryRun: { type: "boolean" },
        checkpoint: { type: "boolean" },
        rollbackOnError: { type: "boolean" },
        continueOnError: { type: "boolean" },
        onError: { type: "string", enum: ["abort", "continue"] },
        opDelayMs: { type: "number", minimum: 0, maximum: 60_000 }
      }
    }
  }
};
