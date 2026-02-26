import { capabilitiesForMode } from "../core/capabilities.js";
import type { AdapterEvent, HealthStatus, OperationEnvelope } from "../types.js";
import type {
  ApplyOpsResult,
  LayerListResult,
  ManifestResult,
  OpenDocumentResult,
  PsAdapter,
  RenderResult
} from "./base.js";

export class CloudAdapter implements PsAdapter {
  readonly mode = "cloud" as const;

  constructor(
    private readonly apiBase: string,
    private readonly token: string | undefined
  ) {}

  capabilities() {
    return capabilitiesForMode(this.mode);
  }

  async health(): Promise<HealthStatus> {
    if (!this.token) {
      return {
        ok: false,
        mode: this.mode,
        detail: "Missing PSAGENT_TOKEN for cloud mode"
      };
    }

    return {
      ok: true,
      mode: this.mode,
      detail: `Cloud mode configured for ${this.apiBase}`
    };
  }

  async openDocument(input: string): Promise<OpenDocumentResult> {
    this.assertConfigured();
    return {
      docRef: input,
      detail: "Cloud doc reference accepted (stub adapter)"
    };
  }

  async getManifest(docRef: string): Promise<ManifestResult> {
    this.assertConfigured();
    return {
      docRef,
      layers: []
    };
  }

  async listLayers(docRef: string, match?: string): Promise<LayerListResult> {
    this.assertConfigured();
    const layers = [
      { id: "layer_title", name: "Title", type: "text", visible: true },
      { id: "layer_hero", name: "Hero", type: "smartObject", visible: true }
    ];
    if (!match) {
      return { layers };
    }

    const regex = new RegExp(match, "i");
    return {
      layers: layers.filter((l) => regex.test(l.name))
    };
  }

  async applyOperations(payload: OperationEnvelope): Promise<ApplyOpsResult> {
    this.assertConfigured();
    return {
      transactionId: payload.transactionId,
      applied: payload.ops.length,
      dryRun: Boolean(payload.safety?.dryRun),
      detail: "Operations accepted by cloud adapter scaffold"
    };
  }

  async render(_docRef: string, format: "png" | "jpg", output: string): Promise<RenderResult> {
    this.assertConfigured();
    return {
      format,
      output,
      detail: "Render request accepted by cloud adapter scaffold"
    };
  }

  async tailEvents(limit: number): Promise<AdapterEvent[]> {
    this.assertConfigured();
    return [
      {
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Cloud events stream not implemented in scaffold (requested limit=${limit})`
      }
    ];
  }

  private assertConfigured(): void {
    if (!this.token) {
      throw new Error("Cloud adapter requires PSAGENT_TOKEN");
    }
  }
}
