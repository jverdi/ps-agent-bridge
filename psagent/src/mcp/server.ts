import readline from "node:readline";
import { buildRuntimeFromOptions, persistSession } from "../core/runtime.js";
import { validateOperationEnvelope } from "../core/validate-ops.js";
import type { SessionState } from "../types.js";
import { toolDefinitions } from "./tool-defs.js";

interface RpcRequest {
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

function writeResponse(response: RpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function toTextContent(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const runtime = buildRuntimeFromOptions({});
  const docRef = (args.docRef as string | undefined) ?? runtime.session?.activeDocument ?? "active";

  switch (name) {
    case "photoshop_capabilities": {
      return {
        mode: runtime.config.mode,
        capabilities: runtime.adapter.capabilities()
      };
    }
    case "photoshop_open_document": {
      const input = args.input as string | undefined;
      if (!input) {
        throw new Error("input is required");
      }
      const result = await runtime.adapter.openDocument(input);
      const nextSession: SessionState = {
        mode: runtime.config.mode,
        profile: runtime.config.profile,
        startedAt: runtime.session?.startedAt ?? new Date().toISOString(),
        activeDocument: result.docRef,
        checkpoints: runtime.session?.checkpoints ?? []
      };
      persistSession(nextSession);
      return { result, session: nextSession };
    }
    case "photoshop_get_manifest": {
      return runtime.adapter.getManifest(docRef);
    }
    case "photoshop_query_layers": {
      const match = args.match as string | undefined;
      return runtime.adapter.listLayers(docRef, match);
    }
    case "photoshop_apply_ops": {
      const payload = validateOperationEnvelope(args.payload);
      payload.doc.ref = payload.doc.ref || docRef;
      return runtime.adapter.applyOperations(payload);
    }
    case "photoshop_render": {
      const format = args.format as "png" | "jpg" | undefined;
      const output = args.output as string | undefined;
      if (!format || (format !== "png" && format !== "jpg")) {
        throw new Error("format must be png|jpg");
      }
      if (!output) {
        throw new Error("output is required");
      }
      return runtime.adapter.render(docRef, format, output);
    }
    case "photoshop_checkpoint_restore": {
      const id = args.id as string | undefined;
      if (!id) {
        throw new Error("id is required");
      }
      if (!runtime.adapter.restoreCheckpoint) {
        throw new Error(`checkpoint restore unsupported for mode=${runtime.config.mode}`);
      }
      return runtime.adapter.restoreCheckpoint(docRef, id);
    }
    case "photoshop_events_tail": {
      const count = Number(args.count ?? 20);
      return runtime.adapter.tailEvents(Number.isFinite(count) ? count : 20);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleRequest(request: RpcRequest): Promise<RpcResponse> {
  try {
    if (request.method === "initialize") {
      return {
        id: request.id,
        result: {
          protocolVersion: "0.1.0",
          serverInfo: {
            name: "psagent-mcp",
            version: "0.1.0"
          },
          capabilities: {
            tools: {}
          }
        }
      };
    }

    if (request.method === "tools/list") {
      return {
        id: request.id,
        result: {
          tools: toolDefinitions
        }
      };
    }

    if (request.method === "tools/call") {
      const name = request.params?.name as string | undefined;
      const args = (request.params?.arguments as Record<string, unknown> | undefined) ?? {};
      if (!name) {
        throw new Error("tools/call requires name");
      }
      const data = await handleToolCall(name, args);
      return {
        id: request.id,
        result: toTextContent(data)
      };
    }

    return {
      id: request.id,
      error: {
        code: -32601,
        message: `Method not found: ${request.method}`
      }
    };
  } catch (error) {
    return {
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on("line", (line) => {
  let request: RpcRequest;
  try {
    request = JSON.parse(line) as RpcRequest;
  } catch {
    writeResponse({
      id: null,
      error: {
        code: -32700,
        message: "Parse error"
      }
    });
    return;
  }

  void handleRequest(request).then(writeResponse);
});
