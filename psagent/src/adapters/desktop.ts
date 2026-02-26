import { randomUUID } from "node:crypto";
import { capabilitiesForMode } from "../core/capabilities.js";
import type { AdapterEvent, Checkpoint, HealthStatus, OperationEnvelope } from "../types.js";
import type {
  ApplyOpsResult,
  LayerListResult,
  ManifestResult,
  OpenDocumentResult,
  PsAdapter,
  RenderResult
} from "./base.js";

interface RpcResponse<T> {
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

export class DesktopAdapter implements PsAdapter {
  readonly mode = "desktop" as const;

  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs: number
  ) {}

  capabilities() {
    return capabilitiesForMode(this.mode);
  }

  async health(): Promise<HealthStatus> {
    try {
      const result = await this.rpc<{ ok?: boolean; detail?: string }>("health", {});
      return {
        ok: result.ok ?? true,
        mode: this.mode,
        detail: result.detail ?? `Bridge reachable at ${this.endpoint}`
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        mode: this.mode,
        detail: `Desktop bridge unavailable at ${this.endpoint}: ${detail}`
      };
    }
  }

  async openDocument(input: string): Promise<OpenDocumentResult> {
    return this.rpc<OpenDocumentResult>("doc.open", { input });
  }

  async getManifest(docRef: string): Promise<ManifestResult> {
    return this.rpc<ManifestResult>("doc.manifest", { docRef });
  }

  async listLayers(docRef: string, match?: string): Promise<LayerListResult> {
    return this.rpc<LayerListResult>("layer.list", { docRef, match });
  }

  async applyOperations(payload: OperationEnvelope): Promise<ApplyOpsResult> {
    return this.rpc<ApplyOpsResult>("ops.apply", { payload });
  }

  async render(docRef: string, format: "png" | "jpg", output: string): Promise<RenderResult> {
    return this.rpc<RenderResult>("render", { docRef, format, output });
  }

  async createCheckpoint(docRef: string, label?: string): Promise<Checkpoint> {
    return this.rpc<Checkpoint>("checkpoint.create", { docRef, label });
  }

  async listCheckpoints(docRef: string): Promise<Checkpoint[]> {
    return this.rpc<Checkpoint[]>("checkpoint.list", { docRef });
  }

  async restoreCheckpoint(docRef: string, checkpointId: string): Promise<{ restored: boolean; detail: string }> {
    return this.rpc<{ restored: boolean; detail: string }>("checkpoint.restore", { docRef, checkpointId });
  }

  async tailEvents(limit: number): Promise<AdapterEvent[]> {
    return this.rpc<AdapterEvent[]>("events.tail", { limit });
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: randomUUID(),
          method,
          params
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        let detail = `HTTP ${response.status} from plugin bridge`;
        try {
          const errorBody = (await response.json()) as { error?: { message?: string } };
          if (errorBody?.error?.message) {
            detail = errorBody.error.message;
          }
        } catch {
          // keep default detail
        }
        throw new Error(detail);
      }

      const body = (await response.json()) as RpcResponse<T>;
      if (body.error) {
        throw new Error(body.error.message);
      }
      if (body.result === undefined) {
        throw new Error("Bridge returned no result payload");
      }
      return body.result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
