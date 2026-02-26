export type AdapterMode = "desktop" | "cloud";

export type OutputMode = "human" | "json" | "plain";

export interface GlobalCliOptions {
  json?: boolean;
  plain?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  noColor?: boolean;
  noInput?: boolean;
  timeout?: string;
  config?: string;
  profile?: string;
  mode?: AdapterMode;
  dryRun?: boolean;
}

export interface SessionState {
  mode: AdapterMode;
  profile: string;
  startedAt: string;
  activeDocument?: string;
  checkpoints?: Checkpoint[];
}

export interface Checkpoint {
  id: string;
  createdAt: string;
  label?: string;
}

export type RefToken = `$${string}`;

export type OperationOnError = "abort" | "continue";

export interface OperationControl {
  ref?: string;
  onError?: OperationOnError;
}

export interface LayerTarget {
  layerName?: string | RefToken;
  layerId?: string | RefToken;
}

export type LayerReference = LayerTarget | string;

export interface DocumentRef {
  ref: string;
}

export type PhotoshopOperation =
  | (OperationControl & {
      op: "createDocument";
      name?: string;
      width?: number;
      height?: number;
      resolution?: number;
      mode?: string;
      fill?: string;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "closeDocument";
      docRef?: string;
      save?: boolean;
      saveOption?: string;
      mode?: string;
      output?: string;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "saveDocument";
      docRef?: string;
      target?: string;
      output?: string;
      format?: string;
      quality?: number;
      asCopy?: boolean;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "saveDocumentAs";
      docRef?: string;
      target?: string;
      output: string;
      format?: string;
      quality?: number;
      asCopy?: boolean;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "duplicateDocument";
      docRef?: string;
      target?: string;
      name?: string;
      mergeLayersOnly?: boolean;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "createLayer";
      name?: string;
      kind?: "pixel" | "smartObject" | "shape";
      parent?: LayerReference;
      at?: number;
    })
  | (OperationControl & {
      op: "createGroup";
      name: string;
      parent?: LayerReference;
      at?: number;
    })
  | (OperationControl & {
      op: "groupLayers";
      targets: LayerReference[];
      name?: string;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "ungroupLayer";
      target: LayerReference;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "deleteLayer";
      target: LayerReference;
    })
  | (OperationControl & {
      op: "renameLayer";
      target: LayerReference;
      name: string;
    })
  | (OperationControl & {
      op: "duplicateLayer";
      target: LayerReference;
      name?: string;
      parent?: LayerReference;
      at?: number;
    })
  | (OperationControl & {
      op: "moveLayer";
      target: LayerReference;
      parent?: LayerReference;
      at?: number;
    })
  | (OperationControl & {
      op: "reorderLayer";
      target: LayerReference;
      before?: LayerReference;
      after?: LayerReference;
      at?: number;
    })
  | (OperationControl & {
      op: "createTextLayer";
      name?: string;
      text: string;
      fontSize?: number;
      parent?: LayerReference;
      at?: number;
      position?: {
        x: number;
        y: number;
      };
    })
  | (OperationControl & {
      op: "createShapeLayer";
      name?: string;
      shape?: "rectangle" | "ellipse" | "path";
      fillColor?: string;
      strokeColor?: string;
      parent?: LayerReference;
      at?: number;
    })
  | (OperationControl & {
      op: "selectLayers";
      targets: LayerReference[];
      mode?: "set" | "add" | "remove";
    })
  | (OperationControl & {
      op: "setVisibility";
      target: LayerReference;
      visible: boolean;
    })
  | (OperationControl & {
      op: "setLocked";
      target: LayerReference;
      locked: boolean;
    })
  | (OperationControl & {
      op: "setOpacity";
      target: LayerReference;
      opacity: number;
    })
  | (OperationControl & {
      op: "setBlendMode";
      target: LayerReference;
      blendMode: string;
    })
  | (OperationControl & {
      op: "setLayerProps";
      target: LayerReference;
      visible?: boolean;
      locked?: boolean;
      opacity?: number;
      blendMode?: string;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "setText";
      target: LayerReference;
      text: string;
      fontSize?: number;
      position?: {
        x: number;
        y: number;
      };
    })
  | (OperationControl & {
      op: "replaceSmartObject";
      target: LayerReference;
      input: string;
      linked?: boolean;
    })
  | (OperationControl & {
      op: "convertToSmartObject";
      target: LayerReference;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "relinkSmartObject";
      target: LayerReference;
      input: string;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "rasterizeLayer";
      target: LayerReference;
    })
  | (OperationControl & {
      op: "mergeLayers";
      targets: LayerReference[];
      name?: string;
    })
  | (OperationControl & {
      op: "flattenImage";
      name?: string;
    })
  | (OperationControl & {
      op: "transformLayer";
      target: LayerReference;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "alignLayers";
      axis?: string;
      targets?: LayerReference[];
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "distributeLayers";
      axis?: string;
      targets?: LayerReference[];
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "resizeCanvas";
      width?: number;
      height?: number;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "resizeImage";
      width?: number;
      height?: number;
      resolution?: number;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "cropDocument";
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "placeAsset";
      input: string;
      linked?: boolean;
      name?: string;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "createAdjustmentLayer";
      adjustment?: string;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "applyFilter";
      filter: string;
      target?: LayerReference;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "addLayerMask";
      target: LayerReference;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "removeLayerMask";
      target: LayerReference;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "applyLayerMask";
      target: LayerReference;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "setSelection";
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "modifySelection";
      mode?: string;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "invertSelection";
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "batchPlay";
      commands: unknown[];
    })
  | (OperationControl & {
      op: "export";
      format: "png" | "jpg";
      output: string;
      target?: LayerReference;
      scale?: number;
    })
  | (OperationControl & {
      op: "setTextStyle";
      target: LayerReference;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "exportDocument";
      format: "png" | "jpg";
      output: string;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "exportLayer";
      target: LayerReference;
      format: "png" | "jpg";
      output: string;
      [key: string]: unknown;
    })
  | (OperationControl & {
      op: "exportLayersByName";
      match: string;
      format: "png" | "jpg";
      outputDir: string;
      [key: string]: unknown;
    });

export interface OperationEnvelope {
  transactionId: string;
  doc: DocumentRef;
  refs?: Record<string, string>;
  ops: PhotoshopOperation[];
  safety?: {
    dryRun?: boolean;
    checkpoint?: boolean;
    rollbackOnError?: boolean;
    onError?: OperationOnError;
    continueOnError?: boolean;
  };
}

export interface OperationExecutionResult {
  index: number;
  op: string;
  status: "applied" | "failed";
  onError: OperationOnError;
  message?: string;
  ref?: string;
  refValue?: string;
}

export interface OperationFailure {
  index: number;
  op: string;
  message: string;
  ref?: string;
}

export interface OperationApplyResponse {
  transactionId: string;
  applied: number;
  dryRun: boolean;
  detail: string;
  rolledBack?: boolean;
  results?: OperationExecutionResult[];
  appliedOps?: OperationExecutionResult[];
  failures?: OperationFailure[];
  refs?: Record<string, string>;
}

export interface ResolvedConfig {
  mode: AdapterMode;
  profile: string;
  outputMode: OutputMode;
  timeoutMs: number;
  pluginEndpoint: string;
  apiBase: string;
  token?: string;
  dryRun: boolean;
  configPath: string;
  projectConfigPath: string;
}

export interface AdapterEvent {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface HealthStatus {
  ok: boolean;
  mode: AdapterMode;
  detail: string;
}
