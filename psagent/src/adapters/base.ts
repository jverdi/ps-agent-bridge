import type { CapabilityMap } from "../core/capabilities.js";
import type { AdapterEvent, Checkpoint, HealthStatus, OperationApplyResponse, OperationEnvelope } from "../types.js";

export interface OpenDocumentResult {
  docRef: string;
  detail: string;
}

export interface ManifestResult {
  docRef: string;
  layers: Array<{ id: string; name: string; type: string }>;
  width?: number;
  height?: number;
}

export interface LayerListResult {
  layers: Array<{ id: string; name: string; type: string; visible?: boolean }>;
}

export type ApplyOpsResult = OperationApplyResponse;

export interface RenderResult {
  format: "png" | "jpg";
  output: string;
  detail: string;
}

export interface PsAdapter {
  readonly mode: "desktop" | "cloud";

  capabilities(): CapabilityMap;
  health(): Promise<HealthStatus>;

  openDocument(input: string): Promise<OpenDocumentResult>;
  getManifest(docRef: string): Promise<ManifestResult>;
  listLayers(docRef: string, match?: string): Promise<LayerListResult>;

  applyOperations(payload: OperationEnvelope): Promise<ApplyOpsResult>;
  render(docRef: string, format: "png" | "jpg", output: string): Promise<RenderResult>;

  createCheckpoint?(docRef: string, label?: string): Promise<Checkpoint>;
  listCheckpoints?(docRef: string): Promise<Checkpoint[]>;
  restoreCheckpoint?(docRef: string, checkpointId: string): Promise<{ restored: boolean; detail: string }>;

  tailEvents(limit: number): Promise<AdapterEvent[]>;
}
