import { createServer } from "node:http";
import type {
  AdapterEvent,
  LayerReference,
  LayerTarget,
  OperationApplyResponse,
  OperationEnvelope,
  OperationExecutionResult,
  OperationFailure,
  OperationOnError,
  PhotoshopOperation
} from "../types.js";

type LayerType = "pixel" | "text" | "smartObject" | "group" | "shape" | "adjustment";

interface Layer {
  id: string;
  name: string;
  type: LayerType;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
  parentId?: string;
  children?: string[];
  text?: {
    content: string;
    fontSize?: number;
    position?: {
      x: number;
      y: number;
    };
  };
  smartObject?: {
    input: string;
    linked: boolean;
    replacedAt: string;
    replaceCount: number;
  };
  shape?: {
    shape: "rectangle" | "ellipse" | "path";
    fillColor?: string;
    strokeColor?: string;
  };
  mask?: {
    enabled: boolean;
    applied?: boolean;
  };
  filters?: Array<{
    name: string;
    params?: Record<string, unknown>;
    appliedAt: string;
  }>;
  transform?: Record<string, unknown>;
  adjustment?: {
    kind: string;
    params?: Record<string, unknown>;
  };
}

interface ExportRecord {
  id: string;
  tx: string;
  docRef: string;
  format: "png" | "jpg";
  output: string;
  createdAt: string;
  via: "op.export" | "render";
  targetLayerId?: string;
}

interface BatchPlayRecord {
  id: string;
  tx: string;
  createdAt: string;
  commandCount: number;
  commands: unknown[];
}

interface DocumentState {
  ref: string;
  width: number;
  height: number;
  rootLayerIds: string[];
  layers: Record<string, Layer>;
  selection: string[];
  selectionInfo?: Record<string, unknown>;
  selectionInverted?: boolean;
  exports: ExportRecord[];
  batchPlayLedger: BatchPlayRecord[];
  saves: Array<{
    id: string;
    tx: string;
    output?: string;
    format?: string;
    createdAt: string;
  }>;
}

interface MockSnapshot {
  activeDocRef: string;
  docs: Record<string, DocumentState>;
  counters: {
    layer: number;
    export: number;
    checkpoint: number;
    batchPlay: number;
    clockMs: number;
  };
}

interface MockCheckpoint {
  id: string;
  createdAt: string;
  label?: string;
  snapshot: MockSnapshot;
}

interface RpcRequest {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
}

interface OperationContext {
  doc: DocumentState;
  refs: Record<string, string>;
  tx: string;
}

interface ExecutionOutcome {
  refValue?: string;
  message?: string;
}

const state = {
  activeDocRef: "active",
  docs: {} as Record<string, DocumentState>,
  checkpoints: [] as MockCheckpoint[],
  events: [] as AdapterEvent[],
  counters: {
    layer: 0,
    export: 0,
    checkpoint: 0,
    batchPlay: 0,
    clockMs: Date.parse("2026-01-01T00:00:00.000Z")
  }
};

function pushEvent(level: "info" | "warn" | "error", message: string): void {
  state.events.push({ timestamp: nextTimestamp(), level, message });
  if (state.events.length > 500) {
    state.events.shift();
  }
}

function cloneDeep<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function nextTimestamp(): string {
  state.counters.clockMs += 1_000;
  return new Date(state.counters.clockMs).toISOString();
}

function nextLayerId(): string {
  state.counters.layer += 1;
  return `layer_${state.counters.layer.toString().padStart(4, "0")}`;
}

function nextExportId(): string {
  state.counters.export += 1;
  return `export_${state.counters.export.toString().padStart(4, "0")}`;
}

function nextCheckpointId(): string {
  state.counters.checkpoint += 1;
  return `checkpoint_${state.counters.checkpoint.toString().padStart(4, "0")}`;
}

function nextBatchPlayId(): string {
  state.counters.batchPlay += 1;
  return `batchplay_${state.counters.batchPlay.toString().padStart(4, "0")}`;
}

function defaultLayerBase(id: string, name: string, type: LayerType): Layer {
  return {
    id,
    name,
    type,
    visible: true,
    locked: false,
    opacity: 100,
    blendMode: "normal"
  };
}

function buildInitialDocument(ref: string): DocumentState {
  const titleLayer: Layer = {
    ...defaultLayerBase("layer_title", "Title", "text"),
    text: {
      content: "Hello World",
      fontSize: 72,
      position: { x: 120, y: 120 }
    }
  };
  const heroLayer: Layer = {
    ...defaultLayerBase("layer_hero", "Hero", "smartObject"),
    smartObject: {
      input: "https://example.com/hero.png",
      linked: false,
      replacedAt: "2026-01-01T00:00:00.000Z",
      replaceCount: 0
    }
  };

  return {
    ref,
    width: 1440,
    height: 900,
    rootLayerIds: [titleLayer.id, heroLayer.id],
    layers: {
      [titleLayer.id]: titleLayer,
      [heroLayer.id]: heroLayer
    },
    selection: [],
    selectionInfo: undefined,
    selectionInverted: false,
    exports: [],
    batchPlayLedger: [],
    saves: []
  };
}

function snapshotState(): MockSnapshot {
  return {
    activeDocRef: state.activeDocRef,
    docs: cloneDeep(state.docs),
    counters: cloneDeep(state.counters)
  };
}

function restoreSnapshot(snapshot: MockSnapshot): void {
  state.activeDocRef = snapshot.activeDocRef;
  state.docs = cloneDeep(snapshot.docs);
  state.counters = cloneDeep(snapshot.counters);
}

function getOrCreateDocument(docRef: string): DocumentState {
  if (!state.docs[docRef]) {
    state.docs[docRef] = buildInitialDocument(docRef);
  }
  return state.docs[docRef];
}

function currentDocument(): DocumentState {
  return getOrCreateDocument(state.activeDocRef);
}

function nextDocumentRef(base?: string): string {
  const label = String(base || "document")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase();
  const seed = `${label || "document"}-${Object.keys(state.docs).length + 1}`;
  if (!state.docs[seed]) {
    return seed;
  }
  let n = 2;
  while (state.docs[`${seed}-${n}`]) {
    n += 1;
  }
  return `${seed}-${n}`;
}

function orderedLayerIds(doc: DocumentState, parentId?: string): string[] {
  if (!parentId) {
    return doc.rootLayerIds;
  }
  const parent = doc.layers[parentId];
  if (!parent || parent.type !== "group") {
    throw new Error(`parent layer is not a group: ${parentId}`);
  }
  if (!parent.children) {
    parent.children = [];
  }
  return parent.children;
}

function flattenLayerIds(doc: DocumentState): string[] {
  const flattened: string[] = [];
  const visit = (ids: string[]) => {
    for (const id of ids) {
      flattened.push(id);
      const layer = doc.layers[id];
      if (layer?.children && layer.children.length > 0) {
        visit(layer.children);
      }
    }
  };
  visit(doc.rootLayerIds);
  return flattened;
}

function flattenLayers(doc: DocumentState): Layer[] {
  return flattenLayerIds(doc)
    .map((id) => doc.layers[id])
    .filter((layer): layer is Layer => Boolean(layer));
}

function findLayerByName(doc: DocumentState, name: string): Layer | undefined {
  return flattenLayers(doc).find((layer) => layer.name === name);
}

function resolveReferenceToken(input: string, refs: Record<string, string>): string {
  if (!input.startsWith("$")) {
    return input;
  }
  const key = input.slice(1);
  const value = refs[key];
  if (!value) {
    throw new Error(`reference not found: ${input}`);
  }
  return value;
}

function resolveLayer(doc: DocumentState, target: LayerReference, refs: Record<string, string>): Layer {
  if (typeof target === "string") {
    const resolved = resolveReferenceToken(target, refs);
    const byId = doc.layers[resolved];
    if (byId) {
      return byId;
    }
    const byName = findLayerByName(doc, resolved);
    if (byName) {
      return byName;
    }
    throw new Error(`target layer not found: ${target}`);
  }

  const layerTarget = target as LayerTarget;
  if (typeof layerTarget.layerId === "string") {
    const resolvedLayerId = resolveReferenceToken(layerTarget.layerId, refs);
    const byId = doc.layers[resolvedLayerId];
    if (byId) {
      return byId;
    }
    throw new Error(`target layer id not found: ${layerTarget.layerId}`);
  }
  if (typeof layerTarget.layerName === "string") {
    const resolvedLayerName = resolveReferenceToken(layerTarget.layerName, refs);
    const byId = doc.layers[resolvedLayerName];
    if (byId) {
      return byId;
    }
    const byName = findLayerByName(doc, resolvedLayerName);
    if (byName) {
      return byName;
    }
    throw new Error(`target layer name not found: ${layerTarget.layerName}`);
  }
  throw new Error("target layer not specified");
}

function resolveParentLayerId(
  doc: DocumentState,
  parent: LayerReference | undefined,
  refs: Record<string, string>
): string | undefined {
  if (!parent) {
    return undefined;
  }
  const layer = resolveLayer(doc, parent, refs);
  if (layer.type !== "group") {
    throw new Error(`parent layer is not a group: ${layer.id}`);
  }
  return layer.id;
}

function removeFromParent(doc: DocumentState, layerId: string): void {
  const layer = doc.layers[layerId];
  if (!layer) {
    return;
  }
  const siblings = orderedLayerIds(doc, layer.parentId);
  const index = siblings.indexOf(layerId);
  if (index >= 0) {
    siblings.splice(index, 1);
  }
}

function clampIndex(index: number, max: number): number {
  if (!Number.isFinite(index)) {
    return max;
  }
  return Math.max(0, Math.min(Math.trunc(index), max));
}

function insertIntoParent(doc: DocumentState, layerId: string, parentId?: string, at?: number): void {
  const siblings = orderedLayerIds(doc, parentId);
  const layer = doc.layers[layerId];
  if (!layer) {
    throw new Error(`layer not found: ${layerId}`);
  }
  removeFromParent(doc, layerId);
  const index = typeof at === "number" ? clampIndex(at, siblings.length) : siblings.length;
  siblings.splice(index, 0, layerId);
  layer.parentId = parentId;
}

function isDescendantOf(doc: DocumentState, layerId: string, ancestorId: string): boolean {
  const layer = doc.layers[layerId];
  if (!layer) {
    return false;
  }
  let cursor = layer.parentId;
  while (cursor) {
    if (cursor === ancestorId) {
      return true;
    }
    cursor = doc.layers[cursor]?.parentId;
  }
  return false;
}

function deleteLayerSubtree(doc: DocumentState, layerId: string): void {
  const layer = doc.layers[layerId];
  if (!layer) {
    return;
  }
  if (layer.children && layer.children.length > 0) {
    for (const childId of [...layer.children]) {
      deleteLayerSubtree(doc, childId);
    }
  }
  removeFromParent(doc, layerId);
  delete doc.layers[layerId];
  doc.selection = doc.selection.filter((id) => id !== layerId);
}

function cloneLayerTree(doc: DocumentState, sourceId: string): string {
  const source = doc.layers[sourceId];
  if (!source) {
    throw new Error(`source layer not found: ${sourceId}`);
  }

  const cloneNode = (id: string): string => {
    const node = doc.layers[id];
    if (!node) {
      throw new Error(`layer not found during clone: ${id}`);
    }
    const clonedId = nextLayerId();
    const clonedLayer: Layer = {
      ...cloneDeep(node),
      id: clonedId,
      parentId: undefined
    };
    if (node.type === "group") {
      clonedLayer.children = [];
      doc.layers[clonedId] = clonedLayer;
      for (const childId of node.children ?? []) {
        const clonedChildId = cloneNode(childId);
        clonedLayer.children.push(clonedChildId);
        doc.layers[clonedChildId].parentId = clonedId;
      }
    } else {
      delete clonedLayer.children;
      doc.layers[clonedId] = clonedLayer;
    }
    return clonedId;
  };

  return cloneNode(sourceId);
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function resolveLayersFromTargets(doc: DocumentState, targets: LayerReference[] | undefined, refs: Record<string, string>): Layer[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    return [];
  }
  return targets.map((target) => resolveLayer(doc, target, refs));
}

function appendExportRecord(
  doc: DocumentState,
  tx: string,
  format: "png" | "jpg",
  output: string,
  via: "op.export" | "render",
  targetLayerId?: string
): ExportRecord {
  const record: ExportRecord = {
    id: nextExportId(),
    tx,
    docRef: doc.ref,
    format,
    output,
    createdAt: nextTimestamp(),
    via,
    ...(targetLayerId ? { targetLayerId } : {})
  };
  doc.exports.push(record);
  return record;
}

function executeOperation(op: PhotoshopOperation, context: OperationContext): ExecutionOutcome {
  let { doc } = context;
  const { refs, tx } = context;

  switch (op.op) {
    case "createDocument": {
      const docRef = nextDocumentRef(op.name || "document");
      const nextDoc = buildInitialDocument(docRef);
      if (typeof op.width === "number") {
        nextDoc.width = Math.max(1, Math.round(op.width));
      }
      if (typeof op.height === "number") {
        nextDoc.height = Math.max(1, Math.round(op.height));
      }
      state.docs[docRef] = nextDoc;
      state.activeDocRef = docRef;
      doc = nextDoc;
      return { refValue: docRef, message: `created document ${docRef}` };
    }
    case "closeDocument": {
      const closingRef = doc.ref;
      if (Object.keys(state.docs).length <= 1) {
        delete state.docs[closingRef];
        const fallback = nextDocumentRef("active");
        state.docs[fallback] = buildInitialDocument(fallback);
        state.activeDocRef = fallback;
      } else {
        delete state.docs[closingRef];
        state.activeDocRef = Object.keys(state.docs)[0];
      }
      return { refValue: closingRef, message: `closed document ${closingRef}` };
    }
    case "saveDocument":
    case "saveDocumentAs": {
      const output = typeof op.output === "string" ? op.output : undefined;
      const format = typeof op.format === "string" ? op.format : output?.split(".").pop();
      doc.saves.push({
        id: `save_${doc.saves.length + 1}`,
        tx,
        output,
        format,
        createdAt: nextTimestamp()
      });
      return { refValue: doc.ref, message: `saved document ${doc.ref}` };
    }
    case "duplicateDocument": {
      const nextRef = nextDocumentRef(op.name || `${doc.ref}-copy`);
      const duplicated = cloneDeep(doc);
      duplicated.ref = nextRef;
      state.docs[nextRef] = duplicated;
      state.activeDocRef = nextRef;
      return { refValue: nextRef, message: `duplicated document ${doc.ref}` };
    }
    case "createLayer": {
      const type = op.kind ?? "pixel";
      const layer: Layer = {
        ...defaultLayerBase(nextLayerId(), op.name ?? `Layer ${state.counters.layer + 1}`, type)
      };
      if (type === "smartObject") {
        layer.smartObject = {
          input: "",
          linked: false,
          replacedAt: nextTimestamp(),
          replaceCount: 0
        };
      }
      if (type === "shape") {
        layer.shape = {
          shape: "rectangle"
        };
      }
      doc.layers[layer.id] = layer;
      const parentId = resolveParentLayerId(doc, op.parent, refs);
      insertIntoParent(doc, layer.id, parentId, op.at);
      return { refValue: layer.id, message: `created ${layer.id}` };
    }
    case "createGroup": {
      const layer: Layer = {
        ...defaultLayerBase(nextLayerId(), op.name, "group"),
        children: []
      };
      doc.layers[layer.id] = layer;
      const parentId = resolveParentLayerId(doc, op.parent, refs);
      insertIntoParent(doc, layer.id, parentId, op.at);
      return { refValue: layer.id, message: `created group ${layer.id}` };
    }
    case "groupLayers": {
      const layers = resolveLayersFromTargets(doc, op.targets, refs);
      if (layers.length < 1) {
        throw new Error("groupLayers requires at least one target");
      }
      const parentId = layers[0].parentId;
      const insertionIndex = orderedLayerIds(doc, parentId).indexOf(layers[0].id);
      const group: Layer = {
        ...defaultLayerBase(nextLayerId(), op.name ?? "Group", "group"),
        parentId,
        children: []
      };
      doc.layers[group.id] = group;
      insertIntoParent(doc, group.id, parentId, insertionIndex < 0 ? undefined : insertionIndex);
      for (const layer of layers) {
        insertIntoParent(doc, layer.id, group.id);
      }
      return { refValue: group.id, message: `grouped ${layers.length} layer(s)` };
    }
    case "ungroupLayer": {
      const group = resolveLayer(doc, op.target, refs);
      if (group.type !== "group") {
        throw new Error("ungroupLayer target is not a group");
      }
      const parentId = group.parentId;
      const siblings = orderedLayerIds(doc, parentId);
      const groupIndex = siblings.indexOf(group.id);
      const children = [...(group.children ?? [])];
      for (let i = 0; i < children.length; i += 1) {
        insertIntoParent(doc, children[i], parentId, groupIndex + i);
      }
      deleteLayerSubtree(doc, group.id);
      return { refValue: parentId, message: `ungrouped ${group.id}` };
    }
    case "deleteLayer": {
      const layer = resolveLayer(doc, op.target, refs);
      const deletedId = layer.id;
      deleteLayerSubtree(doc, layer.id);
      return { refValue: deletedId, message: `deleted ${deletedId}` };
    }
    case "renameLayer": {
      const layer = resolveLayer(doc, op.target, refs);
      layer.name = op.name;
      return { refValue: layer.id, message: `renamed ${layer.id}` };
    }
    case "duplicateLayer": {
      const source = resolveLayer(doc, op.target, refs);
      const duplicatedRootId = cloneLayerTree(doc, source.id);
      if (op.name) {
        doc.layers[duplicatedRootId].name = op.name;
      } else {
        doc.layers[duplicatedRootId].name = `${source.name} copy`;
      }
      const parentId = op.parent ? resolveParentLayerId(doc, op.parent, refs) : source.parentId;
      let at = op.at;
      if (typeof at !== "number" && !op.parent) {
        const siblings = orderedLayerIds(doc, source.parentId);
        const index = siblings.indexOf(source.id);
        if (index >= 0) {
          at = index + 1;
        }
      }
      insertIntoParent(doc, duplicatedRootId, parentId, at);
      return { refValue: duplicatedRootId, message: `duplicated ${source.id}` };
    }
    case "moveLayer": {
      const layer = resolveLayer(doc, op.target, refs);
      const destinationParentId = resolveParentLayerId(doc, op.parent, refs);
      if (destinationParentId === layer.id) {
        throw new Error(`cannot move layer into itself: ${layer.id}`);
      }
      if (destinationParentId && isDescendantOf(doc, destinationParentId, layer.id)) {
        throw new Error(`cannot move layer into descendant: ${layer.id} -> ${destinationParentId}`);
      }
      insertIntoParent(doc, layer.id, destinationParentId, op.at);
      return { refValue: layer.id, message: `moved ${layer.id}` };
    }
    case "reorderLayer": {
      const layer = resolveLayer(doc, op.target, refs);
      if (op.before && op.after) {
        throw new Error("reorderLayer cannot include both before and after");
      }
      if (typeof op.before !== "undefined") {
        const anchor = resolveLayer(doc, op.before, refs);
        if (anchor.id === layer.id) {
          throw new Error("reorderLayer anchor cannot be the same as target");
        }
        removeFromParent(doc, layer.id);
        const siblings = orderedLayerIds(doc, anchor.parentId);
        const index = siblings.indexOf(anchor.id);
        insertIntoParent(doc, layer.id, anchor.parentId, index >= 0 ? index : siblings.length);
        return { refValue: layer.id, message: `reordered ${layer.id}` };
      }
      if (typeof op.after !== "undefined") {
        const anchor = resolveLayer(doc, op.after, refs);
        if (anchor.id === layer.id) {
          throw new Error("reorderLayer anchor cannot be the same as target");
        }
        removeFromParent(doc, layer.id);
        const siblings = orderedLayerIds(doc, anchor.parentId);
        const index = siblings.indexOf(anchor.id);
        insertIntoParent(doc, layer.id, anchor.parentId, index >= 0 ? index + 1 : siblings.length);
        return { refValue: layer.id, message: `reordered ${layer.id}` };
      }
      if (typeof op.at === "number") {
        insertIntoParent(doc, layer.id, layer.parentId, op.at);
        return { refValue: layer.id, message: `reordered ${layer.id}` };
      }
      throw new Error("reorderLayer requires before, after, or at");
    }
    case "createTextLayer": {
      const layer: Layer = {
        ...defaultLayerBase(nextLayerId(), op.name ?? `Text ${state.counters.layer + 1}`, "text"),
        text: {
          content: op.text,
          ...(typeof op.fontSize === "number" ? { fontSize: op.fontSize } : {}),
          ...(op.position ? { position: { x: op.position.x, y: op.position.y } } : {})
        }
      };
      doc.layers[layer.id] = layer;
      const parentId = resolveParentLayerId(doc, op.parent, refs);
      insertIntoParent(doc, layer.id, parentId, op.at);
      return { refValue: layer.id, message: `created text ${layer.id}` };
    }
    case "createShapeLayer": {
      const layer: Layer = {
        ...defaultLayerBase(nextLayerId(), op.name ?? `Shape ${state.counters.layer + 1}`, "shape"),
        shape: {
          shape: op.shape ?? "rectangle",
          ...(op.fillColor ? { fillColor: op.fillColor } : {}),
          ...(op.strokeColor ? { strokeColor: op.strokeColor } : {})
        }
      };
      doc.layers[layer.id] = layer;
      const parentId = resolveParentLayerId(doc, op.parent, refs);
      insertIntoParent(doc, layer.id, parentId, op.at);
      return { refValue: layer.id, message: `created shape ${layer.id}` };
    }
    case "selectLayers": {
      const resolvedIds = uniqueIds(op.targets.map((target) => resolveLayer(doc, target, refs).id));
      const mode = op.mode ?? "set";
      if (mode === "set") {
        doc.selection = resolvedIds;
      } else if (mode === "add") {
        doc.selection = uniqueIds([...doc.selection, ...resolvedIds]);
      } else {
        const remove = new Set(resolvedIds);
        doc.selection = doc.selection.filter((id) => !remove.has(id));
      }
      return { refValue: doc.selection[0], message: `selection ${mode} (${doc.selection.length})` };
    }
    case "setVisibility": {
      const layer = resolveLayer(doc, op.target, refs);
      layer.visible = op.visible;
      return { refValue: layer.id, message: `visibility ${layer.id}=${String(op.visible)}` };
    }
    case "setLocked": {
      const layer = resolveLayer(doc, op.target, refs);
      layer.locked = op.locked;
      return { refValue: layer.id, message: `locked ${layer.id}=${String(op.locked)}` };
    }
    case "setOpacity": {
      const layer = resolveLayer(doc, op.target, refs);
      layer.opacity = Math.max(0, Math.min(100, op.opacity));
      return { refValue: layer.id, message: `opacity ${layer.id}=${String(layer.opacity)}` };
    }
    case "setBlendMode": {
      const layer = resolveLayer(doc, op.target, refs);
      layer.blendMode = op.blendMode;
      return { refValue: layer.id, message: `blendMode ${layer.id}=${op.blendMode}` };
    }
    case "setLayerProps": {
      const layer = resolveLayer(doc, op.target, refs);
      if (typeof op.visible === "boolean") {
        layer.visible = op.visible;
      }
      if (typeof op.locked === "boolean") {
        layer.locked = op.locked;
      }
      if (typeof op.opacity === "number") {
        layer.opacity = Math.max(0, Math.min(100, op.opacity));
      }
      if (typeof op.blendMode === "string" && op.blendMode) {
        layer.blendMode = op.blendMode;
      }
      return { refValue: layer.id, message: `setLayerProps ${layer.id}` };
    }
    case "setText": {
      const layer = resolveLayer(doc, op.target, refs);
      if (layer.type !== "text") {
        throw new Error(`setText target is not a text layer: ${layer.id}`);
      }
      if (!layer.text) {
        layer.text = { content: "" };
      }
      layer.text.content = op.text;
      if (typeof op.fontSize === "number") {
        layer.text.fontSize = op.fontSize;
      }
      if (op.position) {
        layer.text.position = { x: op.position.x, y: op.position.y };
      }
      return { refValue: layer.id, message: `setText ${layer.id}` };
    }
    case "setTextStyle": {
      const layer = resolveLayer(doc, op.target, refs);
      if (layer.type !== "text") {
        throw new Error(`setTextStyle target is not a text layer: ${layer.id}`);
      }
      if (!layer.text) {
        layer.text = { content: "" };
      }
      layer.text = {
        ...layer.text,
        ...(typeof op.fontSize === "number" ? { fontSize: op.fontSize } : {}),
        style: {
          ...(layer.text as any).style,
          ...Object.fromEntries(
            Object.entries(op).filter(([key]) => !["op", "target", "onError", "ref"].includes(key))
          )
        }
      } as typeof layer.text;
      return { refValue: layer.id, message: `setTextStyle ${layer.id}` };
    }
    case "replaceSmartObject": {
      const layer = resolveLayer(doc, op.target, refs);
      const replaceCount = layer.smartObject?.replaceCount ?? 0;
      layer.type = "smartObject";
      layer.smartObject = {
        input: op.input,
        linked: Boolean(op.linked),
        replacedAt: nextTimestamp(),
        replaceCount: replaceCount + 1
      };
      delete layer.text;
      return { refValue: layer.id, message: `replaceSmartObject ${layer.id}` };
    }
    case "convertToSmartObject": {
      const layer = resolveLayer(doc, op.target, refs);
      const replaceCount = layer.smartObject?.replaceCount ?? 0;
      layer.type = "smartObject";
      layer.smartObject = {
        input: layer.smartObject?.input ?? "",
        linked: layer.smartObject?.linked ?? false,
        replacedAt: nextTimestamp(),
        replaceCount
      };
      delete layer.text;
      delete layer.shape;
      return { refValue: layer.id, message: `converted ${layer.id} to smartObject` };
    }
    case "relinkSmartObject": {
      const layer = resolveLayer(doc, op.target, refs);
      if (layer.type !== "smartObject") {
        layer.type = "smartObject";
      }
      const replaceCount = layer.smartObject?.replaceCount ?? 0;
      layer.smartObject = {
        input: op.input,
        linked: true,
        replacedAt: nextTimestamp(),
        replaceCount: replaceCount + 1
      };
      return { refValue: layer.id, message: `relinked smartObject ${layer.id}` };
    }
    case "rasterizeLayer": {
      const layer = resolveLayer(doc, op.target, refs);
      layer.type = "pixel";
      delete layer.text;
      delete layer.smartObject;
      delete layer.shape;
      return { refValue: layer.id, message: `rasterized ${layer.id}` };
    }
    case "mergeLayers": {
      const resolvedIds = uniqueIds(op.targets.map((target) => resolveLayer(doc, target, refs).id));
      if (resolvedIds.length < 2) {
        throw new Error("mergeLayers requires at least two targets");
      }

      const first = doc.layers[resolvedIds[0]];
      if (!first) {
        throw new Error("mergeLayers first target missing");
      }
      const parentId = first.parentId;
      for (const id of resolvedIds.slice(1)) {
        if (doc.layers[id]?.parentId !== parentId) {
          throw new Error("mergeLayers targets must share the same parent");
        }
      }

      const siblings = orderedLayerIds(doc, parentId);
      const insertionIndex = resolvedIds
        .map((id) => siblings.indexOf(id))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0];

      for (const id of resolvedIds) {
        deleteLayerSubtree(doc, id);
      }

      const mergedLayer: Layer = {
        ...defaultLayerBase(nextLayerId(), op.name ?? "Merged Layer", "pixel")
      };
      doc.layers[mergedLayer.id] = mergedLayer;
      insertIntoParent(doc, mergedLayer.id, parentId, insertionIndex);
      doc.selection = [mergedLayer.id];
      return { refValue: mergedLayer.id, message: `merged ${resolvedIds.length} layers` };
    }
    case "flattenImage": {
      const flattenedLayer: Layer = {
        ...defaultLayerBase(nextLayerId(), op.name ?? "Flattened Image", "pixel")
      };
      doc.layers = { [flattenedLayer.id]: flattenedLayer };
      doc.rootLayerIds = [flattenedLayer.id];
      doc.selection = [flattenedLayer.id];
      return { refValue: flattenedLayer.id, message: "flattened document" };
    }
    case "transformLayer": {
      const layer = resolveLayer(doc, op.target, refs);
      layer.transform = {
        ...(layer.transform ?? {}),
        ...Object.fromEntries(Object.entries(op).filter(([key]) => !["op", "target", "onError", "ref"].includes(key)))
      };
      return { refValue: layer.id, message: `transform ${layer.id}` };
    }
    case "alignLayers": {
      const layers = resolveLayersFromTargets(doc, op.targets, refs);
      const count = layers.length > 0 ? layers.length : doc.selection.length;
      return { refValue: doc.selection[0], message: `aligned ${count} layer(s)` };
    }
    case "distributeLayers": {
      const layers = resolveLayersFromTargets(doc, op.targets, refs);
      const count = layers.length > 0 ? layers.length : doc.selection.length;
      return { refValue: doc.selection[0], message: `distributed ${count} layer(s)` };
    }
    case "resizeCanvas": {
      if (typeof op.width === "number") {
        doc.width = Math.max(1, Math.round(op.width));
      }
      if (typeof op.height === "number") {
        doc.height = Math.max(1, Math.round(op.height));
      }
      return { refValue: doc.ref, message: `resizeCanvas ${doc.width}x${doc.height}` };
    }
    case "resizeImage": {
      if (typeof op.width === "number") {
        doc.width = Math.max(1, Math.round(op.width));
      }
      if (typeof op.height === "number") {
        doc.height = Math.max(1, Math.round(op.height));
      }
      return { refValue: doc.ref, message: `resizeImage ${doc.width}x${doc.height}` };
    }
    case "cropDocument": {
      const left = Number((op as any).left ?? 0);
      const top = Number((op as any).top ?? 0);
      const right = Number((op as any).right ?? doc.width);
      const bottom = Number((op as any).bottom ?? doc.height);
      doc.width = Math.max(1, Math.round(right - left));
      doc.height = Math.max(1, Math.round(bottom - top));
      return { refValue: doc.ref, message: `cropped ${doc.width}x${doc.height}` };
    }
    case "placeAsset": {
      const layer: Layer = {
        ...defaultLayerBase(nextLayerId(), op.name ?? `Placed Asset ${state.counters.layer + 1}`, "smartObject"),
        smartObject: {
          input: op.input,
          linked: Boolean(op.linked),
          replacedAt: nextTimestamp(),
          replaceCount: 0
        }
      };
      doc.layers[layer.id] = layer;
      insertIntoParent(doc, layer.id, undefined);
      return { refValue: layer.id, message: `placed asset ${layer.id}` };
    }
    case "createAdjustmentLayer": {
      const layer: Layer = {
        ...defaultLayerBase(nextLayerId(), `Adjustment ${state.counters.layer + 1}`, "adjustment"),
        adjustment: {
          kind: (op.adjustment as string) || "generic",
          params: Object.fromEntries(Object.entries(op).filter(([k]) => !["op", "adjustment", "onError", "ref"].includes(k)))
        }
      };
      doc.layers[layer.id] = layer;
      insertIntoParent(doc, layer.id, undefined);
      return { refValue: layer.id, message: `adjustment ${layer.id}` };
    }
    case "applyFilter": {
      const target = (op as any).target ? resolveLayer(doc, (op as any).target, refs) : doc.selection[0] ? doc.layers[doc.selection[0]] : null;
      if (!target) {
        throw new Error("applyFilter requires target layer or non-empty selection");
      }
      if (!target.filters) {
        target.filters = [];
      }
      target.filters.push({
        name: op.filter,
        params: Object.fromEntries(Object.entries(op).filter(([k]) => !["op", "target", "filter", "onError", "ref"].includes(k))),
        appliedAt: nextTimestamp()
      });
      return { refValue: target.id, message: `applyFilter ${op.filter} on ${target.id}` };
    }
    case "addLayerMask": {
      const layer = resolveLayer(doc, op.target, refs);
      layer.mask = { enabled: true, applied: false };
      return { refValue: layer.id, message: `addLayerMask ${layer.id}` };
    }
    case "removeLayerMask": {
      const layer = resolveLayer(doc, op.target, refs);
      delete layer.mask;
      return { refValue: layer.id, message: `removeLayerMask ${layer.id}` };
    }
    case "applyLayerMask": {
      const layer = resolveLayer(doc, op.target, refs);
      layer.mask = { enabled: false, applied: true };
      return { refValue: layer.id, message: `applyLayerMask ${layer.id}` };
    }
    case "setSelection": {
      doc.selectionInfo = Object.fromEntries(Object.entries(op).filter(([k]) => !["op", "onError", "ref"].includes(k)));
      doc.selectionInverted = false;
      return { refValue: doc.ref, message: "setSelection" };
    }
    case "modifySelection": {
      const mode = (op.mode as string) || "modify";
      doc.selectionInfo = {
        ...(doc.selectionInfo ?? {}),
        modify: {
          mode,
          params: Object.fromEntries(Object.entries(op).filter(([k]) => !["op", "mode", "onError", "ref"].includes(k)))
        }
      };
      return { refValue: doc.ref, message: `modifySelection ${mode}` };
    }
    case "invertSelection": {
      doc.selectionInverted = !doc.selectionInverted;
      return { refValue: doc.ref, message: `invertSelection=${String(doc.selectionInverted)}` };
    }
    case "batchPlay": {
      const record: BatchPlayRecord = {
        id: nextBatchPlayId(),
        tx,
        createdAt: nextTimestamp(),
        commandCount: op.commands.length,
        commands: cloneDeep(op.commands)
      };
      doc.batchPlayLedger.push(record);
      return { refValue: record.id, message: `batchPlay commands=${String(record.commandCount)}` };
    }
    case "export": {
      const targetLayerId = op.target ? resolveLayer(doc, op.target, refs).id : undefined;
      const record = appendExportRecord(doc, tx, op.format, op.output, "op.export", targetLayerId);
      return { refValue: record.id, message: `export ${record.output}` };
    }
    case "exportDocument": {
      const record = appendExportRecord(doc, tx, op.format, op.output, "op.export");
      return { refValue: record.id, message: `exportDocument ${record.output}` };
    }
    case "exportLayer": {
      const layer = resolveLayer(doc, op.target, refs);
      const record = appendExportRecord(doc, tx, op.format, op.output, "op.export", layer.id);
      return { refValue: record.id, message: `exportLayer ${layer.id}` };
    }
    case "exportLayersByName": {
      const regex = new RegExp(op.match, "i");
      const matches = flattenLayers(doc).filter((layer) => regex.test(layer.name));
      const records = matches.map((layer) =>
        appendExportRecord(doc, tx, op.format, `${op.outputDir}/${layer.name}.${op.format}`, "op.export", layer.id)
      );
      return { refValue: records[0]?.id, message: `exportLayersByName count=${records.length}` };
    }
    default:
      throw new Error(`unsupported op: ${(op as { op?: string }).op ?? "unknown"}`);
  }
}

function normalizePayload(rawPayload: unknown): OperationEnvelope {
  const payload = (rawPayload ?? {}) as Partial<OperationEnvelope>;
  const transactionId = String(payload.transactionId ?? "tx-unknown");
  const docRef = String(payload.doc?.ref ?? state.activeDocRef ?? "active");
  const ops = Array.isArray(payload.ops) ? (payload.ops as PhotoshopOperation[]) : [];
  return {
    transactionId,
    doc: { ref: docRef },
    refs: payload.refs ?? {},
    ops,
    safety: payload.safety ?? {}
  };
}

function applyOps(payload: OperationEnvelope): OperationApplyResponse {
  if (!Array.isArray(payload.ops) || payload.ops.length === 0) {
    throw new Error("No ops provided");
  }

  state.activeDocRef = payload.doc.ref;
  const doc = getOrCreateDocument(payload.doc.ref);
  const tx = payload.transactionId;
  const dryRun = Boolean(payload.safety?.dryRun);
  const rollbackOnError = Boolean(payload.safety?.rollbackOnError);
  const defaultOnError: OperationOnError = payload.safety?.onError === "continue" || payload.safety?.continueOnError
    ? "continue"
    : "abort";

  const before = snapshotState();
  const refs: Record<string, string> = { ...(payload.refs ?? {}) };
  const createdRefs: Record<string, string> = {};
  const results: OperationExecutionResult[] = [];
  const failures: OperationFailure[] = [];

  let aborted = false;

  payload.ops.forEach((op, index) => {
    if (aborted) {
      return;
    }

    const onError: OperationOnError = op.onError ?? defaultOnError;

    try {
      const outcome = executeOperation(op, { doc, refs, tx });
      if (op.ref && outcome.refValue) {
        refs[op.ref] = outcome.refValue;
        createdRefs[op.ref] = outcome.refValue;
      }
      results.push({
        index,
        op: op.op,
        status: "applied",
        onError,
        ...(op.ref ? { ref: op.ref } : {}),
        ...(op.ref && outcome.refValue ? { refValue: outcome.refValue } : {}),
        ...(outcome.message ? { message: outcome.message } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        index,
        op: op.op,
        message,
        ...(op.ref ? { ref: op.ref } : {})
      });
      results.push({
        index,
        op: op.op,
        status: "failed",
        onError,
        message,
        ...(op.ref ? { ref: op.ref } : {})
      });
      if (onError === "abort") {
        aborted = true;
      }
    }
  });

  let rolledBack = false;
  if (dryRun) {
    restoreSnapshot(before);
  } else if (rollbackOnError && failures.length > 0) {
    restoreSnapshot(before);
    rolledBack = true;
  }

  const appliedOps = results.filter((result) => result.status === "applied");
  const appliedCount = appliedOps.length;
  pushEvent(
    "info",
    `ops.apply tx=${tx} dryRun=${String(dryRun)} applied=${String(appliedCount)} failures=${String(failures.length)} rolledBack=${String(
      rolledBack
    )}`
  );

  return {
    transactionId: tx,
    applied: appliedCount,
    dryRun,
    detail: failures.length === 0 ? "Applied in mock desktop bridge" : "Applied with operation failures",
    rolledBack,
    results,
    appliedOps,
    failures,
    refs: createdRefs
  };
}

function serializeLayer(doc: DocumentState, layer: Layer): Record<string, unknown> {
  return {
    id: layer.id,
    name: layer.name,
    type: layer.type,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    parentId: layer.parentId,
    selected: doc.selection.includes(layer.id),
    ...(layer.children ? { children: [...layer.children] } : {}),
    ...(layer.text ? { text: cloneDeep(layer.text) } : {}),
    ...(layer.smartObject ? { smartObject: cloneDeep(layer.smartObject) } : {}),
    ...(layer.shape ? { shape: cloneDeep(layer.shape) } : {}),
    ...(layer.adjustment ? { adjustment: cloneDeep(layer.adjustment) } : {}),
    ...(layer.mask ? { mask: cloneDeep(layer.mask) } : {}),
    ...(layer.filters ? { filters: cloneDeep(layer.filters) } : {}),
    ...(layer.transform ? { transform: cloneDeep(layer.transform) } : {})
  };
}

function getManifest(docRef: string): Record<string, unknown> {
  const doc = getOrCreateDocument(docRef);
  return {
    docRef: doc.ref,
    width: doc.width,
    height: doc.height,
    selection: [...doc.selection],
    selectionInfo: cloneDeep(doc.selectionInfo),
    selectionInverted: Boolean(doc.selectionInverted),
    layers: flattenLayers(doc).map((layer) => serializeLayer(doc, layer)),
    saves: cloneDeep(doc.saves),
    exports: cloneDeep(doc.exports),
    batchPlayLedger: cloneDeep(doc.batchPlayLedger)
  };
}

function listLayers(docRef: string, match?: string): Record<string, unknown> {
  const doc = getOrCreateDocument(docRef);
  const re = match ? new RegExp(match, "i") : null;
  const layers = flattenLayers(doc)
    .filter((layer) => (re ? re.test(layer.name) : true))
    .map((layer) => serializeLayer(doc, layer));
  return { layers };
}

function handleMethod(method: string, params: Record<string, unknown> = {}): unknown {
  switch (method) {
    case "health":
      return { detail: "Mock desktop bridge online" };
    case "doc.open": {
      const input = String(params.input ?? "active");
      state.activeDocRef = input;
      getOrCreateDocument(input);
      pushEvent("info", `opened ${input}`);
      return { docRef: input, detail: "Document opened by mock bridge" };
    }
    case "doc.manifest": {
      const docRef = String(params.docRef ?? state.activeDocRef);
      return getManifest(docRef);
    }
    case "layer.list": {
      const docRef = String(params.docRef ?? state.activeDocRef);
      const match = typeof params.match === "string" ? params.match : undefined;
      return listLayers(docRef, match);
    }
    case "ops.apply": {
      const payload = normalizePayload(params.payload);
      return applyOps(payload);
    }
    case "render": {
      const docRef = String(params.docRef ?? state.activeDocRef);
      const format = params.format === "jpg" ? "jpg" : "png";
      const output = String(params.output ?? "./out.png");
      const doc = getOrCreateDocument(docRef);
      appendExportRecord(doc, "render", format, output, "render");
      pushEvent("info", `render ${format} -> ${output}`);
      return {
        format,
        output,
        detail: "Render simulated by mock bridge"
      };
    }
    case "checkpoint.create": {
      const docRef = String(params.docRef ?? state.activeDocRef);
      state.activeDocRef = docRef;
      getOrCreateDocument(docRef);
      const id = nextCheckpointId();
      const item: MockCheckpoint = {
        id,
        createdAt: nextTimestamp(),
        label: typeof params.label === "string" ? params.label : undefined,
        snapshot: snapshotState()
      };
      state.checkpoints.push(item);
      pushEvent("info", `checkpoint created id=${id}`);
      return {
        id: item.id,
        createdAt: item.createdAt,
        ...(item.label ? { label: item.label } : {})
      };
    }
    case "checkpoint.list":
      return state.checkpoints.map((item) => ({
        id: item.id,
        createdAt: item.createdAt,
        ...(item.label ? { label: item.label } : {})
      }));
    case "checkpoint.restore": {
      const checkpointId = String(params.checkpointId ?? "");
      const checkpoint = state.checkpoints.find((cp) => cp.id === checkpointId);
      if (!checkpoint) {
        throw new Error(`checkpoint not found: ${checkpointId}`);
      }
      restoreSnapshot(checkpoint.snapshot);
      pushEvent("info", `checkpoint restored id=${checkpointId}`);
      return {
        restored: true,
        detail: `Restored checkpoint ${checkpointId}`
      };
    }
    case "events.tail": {
      const limit = Number(params.limit ?? 20);
      return state.events.slice(-Math.max(1, limit));
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

state.docs.active = buildInitialDocument("active");

export function startMockBridge(port: number): void {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const rpc = JSON.parse(body) as RpcRequest;
        const result = handleMethod(rpc.method ?? "", rpc.params ?? {});
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: rpc.id,
            result
          })
        );
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: null,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error)
            }
          })
        );
      }
    });
  });

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`mock bridge listening on http://127.0.0.1:${port}/rpc\n`);
  });
}
