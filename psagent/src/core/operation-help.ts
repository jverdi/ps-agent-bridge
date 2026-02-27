import { GENERATED_OPERATION_CATALOG, GENERATED_OPERATION_ENTRIES } from "./operation-help.generated.js";

export interface OperationCatalogGroup {
  name: string;
  operations: string[];
}

export interface OperationHelpEntry {
  name: string;
  aliases: string[];
  required: string;
  supportedArgs: string;
  example: string;
}

export interface OperationHelpDocs {
  groups: OperationCatalogGroup[];
  entries: OperationHelpEntry[];
  byName: Map<string, OperationHelpEntry>;
  catalogOperationNames: Set<string>;
}

let cachedDocs: OperationHelpDocs | null = null;

export function loadOperationHelpDocs(): OperationHelpDocs {
  if (cachedDocs) {
    return cachedDocs;
  }

  const groups: OperationCatalogGroup[] = GENERATED_OPERATION_CATALOG.map((group) => ({
    name: group.name,
    operations: [...group.operations]
  }));
  const entries: OperationHelpEntry[] = GENERATED_OPERATION_ENTRIES.map((entry) => ({
    name: entry.name,
    aliases: [...entry.aliases],
    required: entry.required,
    supportedArgs: entry.supportedArgs,
    example: entry.example
  }));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const catalogOperationNames = new Set<string>();

  for (const group of groups) {
    for (const operationName of group.operations) {
      catalogOperationNames.add(operationName);
    }
  }

  cachedDocs = {
    groups,
    entries,
    byName,
    catalogOperationNames
  };

  return cachedDocs;
}
