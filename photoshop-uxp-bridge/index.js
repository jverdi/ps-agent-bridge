const photoshop = require("photoshop");
const uxp = require("uxp");

const { app, core, action, constants } = photoshop;
const localFileSystem = uxp?.storage?.localFileSystem;
const localFileSystemTypes = uxp?.storage?.types;
const localFileSystemFormats = uxp?.storage?.formats;

const bridgeState = {
  endpoint: "http://127.0.0.1:43120",
  clientId: `uxp-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
  connected: false,
  stopRequested: false,
  lastPollError: "",
  hotReload: {
    running: false,
    lastSeenVersion: null,
    lastError: "",
    firstConnectLogged: false
  },
  checkpoints: [],
  events: []
};

const MAX_LOG_LINES = 300;
const MAX_EVENT_HISTORY = 500;
const MAX_MODAL_RETRIES = 5;
const DEFAULT_ON_ERROR = "abort";
const AUTO_CONNECT_ON_STARTUP = true;
const AUTO_CONNECT_MAX_ATTEMPTS = 8;
const AUTO_CONNECT_RETRY_MS = 1000;
const HOT_RELOAD_ON_STARTUP = true;
const HOT_RELOAD_ENDPOINT = "http://127.0.0.1:43121";
const HOT_RELOAD_POLL_MS = 900;
const HOT_RELOAD_REQUEST_TIMEOUT_MS = 1200;
const HOT_RELOAD_RETRY_MS = 900;

const APPLY_OPS_CAPABILITIES = {
  opLocalRefs: true,
  refSyntax: "$name and $name.path",
  perOpOnError: true,
  rollbackOnError: {
    supported: true,
    strategy: "historySnapshot+historyPointer",
    behavior: "best-effort"
  },
  structuredResult: true,
  batchPlayErrorIntrospection: true
};

const DEFAULT_BATCHPLAY_OPTIONS = {
  synchronousExecution: false,
  modalBehavior: "execute",
  dialogOptions: "silent"
};

const REF_ASSIGNMENT_FIELDS = ["ref", "refId", "as", "outputRef", "storeAs", "idRef"];
const REF_LITERAL_TOP_LEVEL_FIELDS = new Set(["text", "contents"]);
const OP_ALIAS_TABLE = new Map();
const OP_HANDLER_TABLE = new Map();
const OP_REQUIRES_ACTIVE_DOCUMENT = new Set();
const OP_REQUIRES_LAYER_TARGET = new Set([
  "deleteLayer",
  "renameLayer",
  "duplicateLayer",
  "selectLayer",
  "moveLayer",
  "setLayerVisibility",
  "showLayer",
  "hideLayer",
  "setLayerOpacity",
  "setBlendMode",
  "setLayerProps",
  "bringLayerToFront",
  "sendLayerToBack",
  "mergeLayer",
  "rasterizeLayer",
  "unlinkLayer",
  "transformLayer",
  "translateLayer",
  "scaleLayer",
  "rotateLayer",
  "flipLayer",
  "skewLayer",
  "convertToSmartObject",
  "replaceSmartObject",
  "relinkSmartObject",
  "editSmartObject",
  "selectLayerPixels",
  "createLayerMask",
  "deleteLayerMask",
  "applyLayerMask",
  "applyGaussianBlur",
  "applyUnsharpMask",
  "applySharpen",
  "applyBlur",
  "setText",
  "setTextStyle",
  "exportLayer"
]);

function setConnectionUI(connected) {
  const connectBtn = document.getElementById("connectBtn");
  const connectionStatus = document.getElementById("connectionStatus");

  if (!connectBtn || !connectionStatus) {
    return;
  }

  connectBtn.textContent = connected ? "Disconnect Bridge" : "Connect Bridge";
  connectBtn.classList.toggle("connected", connected);
  connectionStatus.textContent = connected ? "Status: Connected" : "Status: Disconnected";
  connectionStatus.classList.toggle("connected", connected);
}

function safeStringify(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendLog(label, value) {
  const output = document.getElementById("log");
  if (!output) {
    return;
  }

  const timestamp = new Date().toISOString();
  const body = safeStringify(value);
  const line = `[${timestamp}] ${label}: ${body}`;

  const lines = output.textContent ? output.textContent.split("\n") : [];
  lines.push(line);
  if (lines.length > MAX_LOG_LINES) {
    lines.splice(0, lines.length - MAX_LOG_LINES);
  }
  output.textContent = lines.join("\n");
  output.scrollTop = output.scrollHeight;
}

function pushEvent(level, message) {
  bridgeState.events.push({
    timestamp: new Date().toISOString(),
    level,
    message
  });
  if (bridgeState.events.length > MAX_EVENT_HISTORY) {
    bridgeState.events.shift();
  }
  appendLog(level, message);
}

function initializeLogPanel() {
  const output = document.getElementById("log");
  if (!output) {
    return;
  }
  output.textContent = "";
  appendLog("info", "transaction log ready");
}

function clearLogPanel() {
  const output = document.getElementById("log");
  if (!output) {
    return;
  }
  output.textContent = "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  return error?.message || String(error);
}

function classifyPhotoshopError(error) {
  const message = getErrorMessage(error);
  return {
    message,
    isModalBusy: /modal state/i.test(message),
    isCommandUnavailable: /not currently available/i.test(message),
    isProgramError: /program error/i.test(message),
    isInvalidDocument: /not a valid photoshop document/i.test(message)
  };
}

function normalizePhotoshopExecutionError(commandName, error) {
  const classified = classifyPhotoshopError(error);
  if (classified.isModalBusy) {
    return new Error("Photoshop is busy in a modal state. Exit text edit/transform/dialog mode, then retry.");
  }
  if (classified.isInvalidDocument) {
    return new Error(`Operation '${commandName}' failed because the active document is not valid in the current Photoshop state.`);
  }
  if (classified.isCommandUnavailable) {
    return new Error(`Operation '${commandName}' is not currently available in this Photoshop state.`);
  }
  if (classified.isProgramError) {
    return new Error(`Operation '${commandName}' hit a Photoshop program error. Retry once; if it persists, use a simpler op sequence.`);
  }
  return error;
}

async function runModalTask(commandName, task, options = {}) {
  const maxRetries = Number.isFinite(Number(options.maxRetries)) ? Math.max(1, Number(options.maxRetries)) : MAX_MODAL_RETRIES;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1000, Number(options.timeoutMs)) : 30000;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      let result;
      await core.executeAsModal(
        async () => {
          result = await task({ attempt, maxRetries });
        },
        {
          commandName,
          timeOut: timeoutMs
        }
      );
      return result;
    } catch (error) {
      lastError = error;
      const classified = classifyPhotoshopError(error);
      if (!classified.isModalBusy || attempt >= maxRetries) {
        break;
      }
      pushEvent("warn", `modal state busy; retrying ${commandName} attempt=${attempt + 1}/${maxRetries}`);
      await sleep(350);
    }
  }

  if (lastError) {
    throw normalizePhotoshopExecutionError(commandName, lastError);
  }

  return undefined;
}

function sanitizeError(error) {
  const message = error?.message || String(error);
  const detail = {
    message,
    name: error?.name || "Error"
  };

  if (typeof error?.number === "number") {
    detail.number = error.number;
  }
  if (typeof error?.result === "number") {
    detail.result = error.result;
  }
  if (typeof error?.stack === "string") {
    detail.stack = error.stack.split("\n").slice(0, 6).join("\n");
  }

  return detail;
}

function isEmptySelectionExportError(error) {
  const detail = sanitizeError(error);
  return /selections? cannot be exported because (they|it) (is|are) empty/i.test(detail.message);
}

function cloneSerializable(value) {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function flattenLayers(layers, acc = []) {
  for (const layer of layers || []) {
    acc.push(layer);
    if (layer.layers && layer.layers.length > 0) {
      flattenLayers(layer.layers, acc);
    }
  }
  return acc;
}

function pickSafeInsertBaseLayer(doc) {
  const layers = flattenLayers(doc?.layers || []);
  if (layers.length === 0) {
    return null;
  }

  const background = layers.find((layer) => layer?.name === "Background");
  if (background) {
    return background;
  }

  // Bottom-most layer is the safest insertion anchor for APIs that can
  // otherwise replace the currently active pixel layer.
  return layers[layers.length - 1];
}

function activeDocumentOrThrow() {
  const doc = app.activeDocument;
  if (!doc) {
    throw new Error("No active document in Photoshop");
  }
  return doc;
}

function getAllDocuments() {
  try {
    return Array.from(app.documents || []);
  } catch {
    return [];
  }
}

function getDocDimension(value) {
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof value.value === "number") {
    return value.value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeEnumLookup(enumObj, raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  if (!enumObj || typeof raw !== "string") {
    return raw;
  }

  const normalizedRaw = raw.replace(/[^a-z0-9]/gi, "").toLowerCase();
  for (const [key, value] of Object.entries(enumObj)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (normalizedKey === normalizedRaw) {
      return value;
    }
    if (String(value).replace(/[^a-z0-9]/gi, "").toLowerCase() === normalizedRaw) {
      return value;
    }
  }

  return raw;
}

function normalizeLookupToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function extractFontStringCandidates(fontRecord) {
  if (!fontRecord || typeof fontRecord !== "object") {
    return [];
  }

  const rawValues = [
    fontRecord.name,
    fontRecord.fullName,
    fontRecord.postScriptName,
    fontRecord.familyName,
    fontRecord.styleName,
    fontRecord.fontName
  ];

  return rawValues
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);
}

function resolveInstalledFontName(rawFontName) {
  const requested = String(rawFontName || "").trim();
  if (!requested) {
    return "";
  }

  const fonts = Array.isArray(app?.fonts) ? app.fonts : [];
  if (fonts.length === 0) {
    return requested;
  }

  const requestedToken = normalizeLookupToken(requested);
  let best = null;

  for (const font of fonts) {
    const candidates = extractFontStringCandidates(font);
    if (candidates.length === 0) {
      continue;
    }

    let score = 0;
    for (const candidate of candidates) {
      const token = normalizeLookupToken(candidate);
      if (!token) {
        continue;
      }

      if (token === requestedToken) {
        score = Math.max(score, 100);
        continue;
      }
      if (token.includes(requestedToken) || requestedToken.includes(token)) {
        score = Math.max(score, 80);
      }

      const requestedParts = requested.toLowerCase().match(/[a-z0-9]+/g) || [];
      if (requestedParts.length > 0) {
        const matchedParts = requestedParts.filter((part) => token.includes(part)).length;
        if (matchedParts > 0) {
          score = Math.max(score, Math.floor((matchedParts / requestedParts.length) * 70));
        }
      }
    }

    if (!best || score > best.score) {
      best = {
        score,
        value:
          (typeof font.postScriptName === "string" && font.postScriptName.trim()) ||
          (typeof font.name === "string" && font.name.trim()) ||
          (typeof font.fullName === "string" && font.fullName.trim()) ||
          requested
      };
    }
  }

  if (!best || best.score < 60) {
    return requested;
  }

  return best.value;
}

function fontLooksLike(value, requested) {
  const actualToken = normalizeLookupToken(value);
  const requestedToken = normalizeLookupToken(requested);
  if (!actualToken || !requestedToken) {
    return false;
  }
  return actualToken === requestedToken || actualToken.includes(requestedToken) || requestedToken.includes(actualToken);
}

function normalizeTextContents(value) {
  // Photoshop text layers expect carriage-return separators for line breaks.
  return String(value).replace(/\r\n?/g, "\n").replace(/\n/g, "\r");
}

function layerType(layer) {
  if (layer.layers && layer.layers.length > 0) {
    return "group";
  }
  if (layer.textItem) {
    return "text";
  }

  try {
    if (layer.kind) {
      return String(layer.kind);
    }
  } catch {
    // ignore
  }

  return "pixel";
}

function serializeLayer(layer) {
  if (!layer) {
    return null;
  }

  return {
    id: String(layer.id),
    name: layer.name,
    type: layerType(layer),
    visible: layer.visible !== false,
    kind: layer.kind ? String(layer.kind) : undefined
  };
}

function serializeDocument(doc) {
  if (!doc) {
    return null;
  }

  return {
    id: String(doc.id),
    title: doc.title,
    width: getDocDimension(doc.width),
    height: getDocDimension(doc.height),
    resolution: toFiniteNumber(doc.resolution, undefined)
  };
}

function isLayerLike(value) {
  return value && typeof value === "object" && ("layerId" in value || "id" in value || "layerName" in value || "name" in value);
}

function buildLayerRefValue(layer) {
  return {
    kind: "layer",
    layerId: String(layer.id),
    layerName: layer.name,
    id: String(layer.id),
    name: layer.name
  };
}

function buildDocumentRefValue(doc) {
  return {
    kind: "document",
    docId: String(doc.id),
    title: doc.title,
    ref: "active"
  };
}

function normalizeRefName(rawName) {
  if (typeof rawName !== "string") {
    return null;
  }
  const trimmed = rawName.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
}

function parseRefToken(input) {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  if (!/^\$[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    return null;
  }

  const token = trimmed.slice(1);
  const [name, ...rest] = token.split(".");
  if (!name) {
    return null;
  }

  return {
    name,
    path: rest
  };
}

function getRefValueByToken(token, refs) {
  const parsed = parseRefToken(token);
  if (!parsed) {
    return undefined;
  }

  if (!(parsed.name in refs)) {
    throw new Error(`Unknown ref token '${token}'`);
  }

  let value = refs[parsed.name];
  for (const key of parsed.path) {
    if (value === null || value === undefined || typeof value !== "object") {
      throw new Error(`Ref token '${token}' could not resolve path '${key}'`);
    }
    value = value[key];
  }

  return value;
}

function resolveRefsInValue(value, refs, path = []) {
  if (typeof value === "string") {
    const topLevelKey = path.length > 0 ? path[0] : "";
    const skipTopLevel =
      path.length === 1 &&
      (topLevelKey === "op" ||
        topLevelKey === "onError" ||
        REF_ASSIGNMENT_FIELDS.includes(topLevelKey) ||
        REF_LITERAL_TOP_LEVEL_FIELDS.has(topLevelKey));
    if (skipTopLevel) {
      return value;
    }

    const refValue = getRefValueByToken(value, refs);
    if (refValue === undefined) {
      return value;
    }
    return cloneSerializable(refValue);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => resolveRefsInValue(item, refs, [...path, String(index)]));
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = resolveRefsInValue(child, refs, [...path, key]);
    }
    return out;
  }

  return value;
}

function resolveOperationRefs(op, refs) {
  return resolveRefsInValue(op, refs, []);
}

function normalizeLayerTarget(rawTarget, refs) {
  const target = resolveRefsInValue(rawTarget, refs, ["target"]);

  if (target === undefined || target === null || target === "") {
    return null;
  }

  if (typeof target === "number") {
    return {
      layerId: String(target)
    };
  }

  if (typeof target === "string") {
    const numeric = Number(target);
    if (Number.isFinite(numeric)) {
      return {
        layerId: String(target)
      };
    }
    return {
      layerName: target
    };
  }

  if (Array.isArray(target)) {
    throw new Error("Layer target must not be an array");
  }

  if (target.kind === "layer") {
    return {
      layerId: target.layerId || target.id,
      layerName: target.layerName || target.name
    };
  }

  if (target.target && typeof target.target === "object") {
    return normalizeLayerTarget(target.target, refs);
  }

  if (target.layer && typeof target.layer === "object") {
    return normalizeLayerTarget(target.layer, refs);
  }

  if (target.ref !== undefined && typeof target.ref !== "object") {
    return normalizeLayerTarget(target.ref, refs);
  }

  const layerId = target.layerId ?? target.id;
  const layerName = target.layerName ?? target.name;

  if (!layerId && !layerName) {
    throw new Error("Target does not include layerId/layerName or a valid $ref");
  }

  return {
    layerId: layerId !== undefined ? String(layerId) : undefined,
    layerName: layerName !== undefined ? String(layerName) : undefined
  };
}

function findLayer(rawTarget, refs, options = {}) {
  const doc = options.doc || activeDocumentOrThrow();
  const allLayers = flattenLayers(doc.layers || []);

  if (rawTarget === undefined || rawTarget === null || rawTarget === "") {
    if (doc.activeLayers && doc.activeLayers[0]) {
      return doc.activeLayers[0];
    }
    if (options.allowAny) {
      return allLayers[0] || null;
    }
    throw new Error("No target layer specified and no active layer available");
  }

  const target = normalizeLayerTarget(rawTarget, refs);

  if (target?.layerId) {
    const numericId = Number(target.layerId);
    const byId = allLayers.find((layer) => {
      if (Number.isFinite(numericId) && layer.id === numericId) {
        return true;
      }
      return String(layer.id) === String(target.layerId);
    }) || null;
    if (byId) {
      return byId;
    }
  }

  if (target?.layerName) {
    return allLayers.find((layer) => layer.name === target.layerName) || null;
  }

  return null;
}

function findDocument(rawTarget, refs) {
  if (rawTarget === undefined || rawTarget === null || rawTarget === "" || rawTarget === "active") {
    return activeDocumentOrThrow();
  }

  const target = resolveRefsInValue(rawTarget, refs || {}, ["doc"]);
  const docs = getAllDocuments();

  if (target === "active") {
    return activeDocumentOrThrow();
  }

  if (typeof target === "number") {
    return docs.find((doc) => Number(doc.id) === target) || null;
  }

  if (typeof target === "string") {
    const numeric = Number(target);
    if (Number.isFinite(numeric)) {
      return docs.find((doc) => Number(doc.id) === numeric) || null;
    }
    return docs.find((doc) => doc.title === target) || null;
  }

  if (target && typeof target === "object") {
    const docId = target.docId ?? target.id;
    const title = target.title ?? target.docTitle;

    if (docId !== undefined) {
      const numeric = Number(docId);
      const byId = docs.find((doc) => (Number.isFinite(numeric) ? Number(doc.id) === numeric : String(doc.id) === String(docId)));
      if (byId) {
        return byId;
      }
    }

    if (title !== undefined) {
      const byTitle = docs.find((doc) => doc.title === String(title));
      if (byTitle) {
        return byTitle;
      }
    }

    if (target.ref !== undefined) {
      return findDocument(target.ref, refs);
    }
  }

  return null;
}

async function selectLayerById(layerId) {
  await runBatchPlay(
    [
      {
        _obj: "select",
        _target: [
          {
            _ref: "layer",
            _id: Number(layerId)
          }
        ],
        makeVisible: false,
        _options: {
          dialogOptions: "dontDisplay"
        }
      }
    ],
    undefined,
    { op: "selectLayerById" }
  );
}

async function selectLayer(layer) {
  if (!layer) {
    throw new Error("Cannot select empty layer target");
  }

  const doc = layer.document || activeDocumentOrThrow();

  try {
    doc.activeLayers = [layer];
  } catch {
    await selectLayerById(layer.id);
  }
}

function normalizePathLike(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return "";
  }

  if (/^[a-z-]+:\//i.test(raw)) {
    return raw;
  }

  if (/^[a-zA-Z]:\\/.test(raw)) {
    return `file:/${raw.replace(/\\/g, "/")}`;
  }

  if (raw.startsWith("/")) {
    return `file:${raw}`;
  }

  return `file:${raw}`;
}

function isLikelyPath(input) {
  if (typeof input !== "string") {
    return false;
  }

  if (/^[a-z-]+:\//i.test(input)) {
    return true;
  }
  if (input.startsWith("/") || /^[a-zA-Z]:\\/.test(input)) {
    return true;
  }
  return /[\\/]/.test(input);
}

function isHttpUrl(input) {
  return typeof input === "string" && /^https?:\/\//i.test(input.trim());
}

function extensionFromContentType(contentType) {
  const value = String(contentType || "").toLowerCase();
  if (value.includes("image/png")) return "png";
  if (value.includes("image/jpeg") || value.includes("image/jpg")) return "jpg";
  if (value.includes("image/webp")) return "webp";
  if (value.includes("image/gif")) return "gif";
  if (value.includes("image/tiff")) return "tif";
  if (value.includes("image/bmp")) return "bmp";
  if (value.includes("image/svg+xml")) return "svg";
  if (value.includes("application/pdf")) return "pdf";
  if (value.includes("application/vnd.adobe.photoshop")) return "psd";
  return "";
}

function extensionFromUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const pathName = parsed.pathname || "";
    const match = pathName.match(/\.([a-z0-9]{1,8})$/i);
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function parsePngDimensions(bytes) {
  if (!bytes || bytes.length < 24) {
    return null;
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) {
      return null;
    }
  }
  const ihdr = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (ihdr !== "IHDR") {
    return null;
  }

  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    pixelWidth: width >>> 0,
    pixelHeight: height >>> 0
  };
}

function parseGifDimensions(bytes) {
  if (!bytes || bytes.length < 10) {
    return null;
  }
  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (header !== "GIF87a" && header !== "GIF89a") {
    return null;
  }

  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    pixelWidth: width,
    pixelHeight: height
  };
}

function parseJpegDimensions(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    offset += 2;

    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    if (offset + 1 >= bytes.length) {
      break;
    }

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (!Number.isFinite(segmentLength) || segmentLength < 2 || offset + segmentLength > bytes.length) {
      break;
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame && segmentLength >= 7) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return {
          pixelWidth: width,
          pixelHeight: height
        };
      }
    }

    offset += segmentLength;
  }

  return null;
}

function parseImageDimensions(bytes, contentType, ext) {
  const token = String(contentType || ext || "")
    .trim()
    .toLowerCase();

  if (token.includes("png") || ext === "png") {
    return parsePngDimensions(bytes);
  }
  if (token.includes("jpeg") || token.includes("jpg") || ext === "jpg" || ext === "jpeg") {
    return parseJpegDimensions(bytes);
  }
  if (token.includes("gif") || ext === "gif") {
    return parseGifDimensions(bytes);
  }

  return parsePngDimensions(bytes) || parseJpegDimensions(bytes) || parseGifDimensions(bytes);
}

async function writeBinaryEntry(entry, bytes) {
  const formatBinary = localFileSystemFormats?.binary;

  if (formatBinary !== undefined) {
    await entry.write(bytes, { format: formatBinary });
    return;
  }

  try {
    await entry.write(bytes);
  } catch {
    await entry.write(Array.from(bytes));
  }
}

async function downloadRemoteToTempEntry(urlString) {
  if (!localFileSystem || typeof localFileSystem.getTemporaryFolder !== "function") {
    throw new Error("UXP temporary folder API unavailable");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new Error(`Invalid remote URL '${urlString}'`);
  }

  const response = await fetch(parsedUrl.toString());
  if (!response.ok) {
    throw new Error(`Failed to download remote asset: HTTP ${response.status} (${parsedUrl.toString()})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const extFromType = extensionFromContentType(response.headers?.get("content-type"));
  const extFromPath = extensionFromUrl(parsedUrl.toString());
  const ext = extFromPath || extFromType || "bin";
  const contentType = response.headers?.get("content-type") || "";
  const metadata = parseImageDimensions(bytes, contentType, ext);
  const fileName = `psagent-remote-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.${ext}`;

  const tmpFolder = await localFileSystem.getTemporaryFolder();
  const fileEntry = await tmpFolder.createFile(fileName, { overwrite: true });
  await writeBinaryEntry(fileEntry, bytes);
  return {
    entry: fileEntry,
    metadata
  };
}

async function getEntryFromPath(pathLike) {
  if (!localFileSystem) {
    throw new Error("UXP localFileSystem API unavailable");
  }
  const fsUrl = normalizePathLike(pathLike);
  return localFileSystem.getEntryWithUrl(fsUrl);
}

async function getFolderEntryForPath(pathLike, { create } = { create: false }) {
  if (!localFileSystem) {
    throw new Error("UXP localFileSystem API unavailable");
  }

  const fsUrl = normalizePathLike(pathLike);
  try {
    return await localFileSystem.getEntryWithUrl(fsUrl);
  } catch (error) {
    if (!create || typeof localFileSystem.createEntryWithUrl !== "function") {
      throw error;
    }
    return localFileSystem.createEntryWithUrl(fsUrl, {
      type: localFileSystemTypes?.folder,
      overwrite: false
    });
  }
}

async function getFileEntryForSave(pathLike) {
  if (!localFileSystem) {
    throw new Error("UXP localFileSystem API unavailable");
  }

  const fsUrl = normalizePathLike(pathLike);

  if (typeof localFileSystem.createEntryWithUrl === "function") {
    try {
      return await localFileSystem.createEntryWithUrl(fsUrl, { overwrite: true });
    } catch {
      // fallback to getEntryWithUrl below
    }
  }

  return localFileSystem.getEntryWithUrl(fsUrl);
}

async function resolveSessionTokenWithMetadata(pathOrToken) {
  if (!pathOrToken) {
    throw new Error("Input path/token is required");
  }

  if (typeof pathOrToken === "object" && pathOrToken.isFile) {
    if (!localFileSystem?.createSessionToken) {
      throw new Error("UXP createSessionToken API unavailable");
    }
    return {
      token: localFileSystem.createSessionToken(pathOrToken),
      metadata: null
    };
  }

  const raw = String(pathOrToken);
  if (isHttpUrl(raw)) {
    const remote = await downloadRemoteToTempEntry(raw);
    if (!localFileSystem?.createSessionToken) {
      throw new Error("UXP createSessionToken API unavailable");
    }
    return {
      token: localFileSystem.createSessionToken(remote.entry),
      metadata: remote.metadata || null
    };
  }

  if (!isLikelyPath(raw)) {
    return {
      token: raw,
      metadata: null
    };
  }

  const entry = await getEntryFromPath(raw);
  if (!localFileSystem?.createSessionToken) {
    throw new Error("UXP createSessionToken API unavailable");
  }
  return {
    token: localFileSystem.createSessionToken(entry),
    metadata: null
  };
}

async function resolveSessionToken(pathOrToken) {
  const resolved = await resolveSessionTokenWithMetadata(pathOrToken);
  return resolved.token;
}

function splitOutputPath(outputPath) {
  const normalized = String(outputPath || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) {
    return {
      folder: ".",
      fileName: normalized
    };
  }

  return {
    folder: normalized.slice(0, idx),
    fileName: normalized.slice(idx + 1)
  };
}

function descriptorErrorItems(descriptors) {
  if (!Array.isArray(descriptors)) {
    return [];
  }

  const errors = [];
  for (let i = 0; i < descriptors.length; i += 1) {
    const descriptor = descriptors[i];
    if (!descriptor || typeof descriptor !== "object") {
      continue;
    }

    const resultCode = typeof descriptor.result === "number" ? descriptor.result : Number(descriptor.result);
    const isErrorObj = descriptor._obj === "error";
    const hasFailureResult = Number.isFinite(resultCode) && resultCode < 0;

    if (!isErrorObj && !hasFailureResult) {
      continue;
    }

    errors.push({
      index: i,
      result: Number.isFinite(resultCode) ? resultCode : undefined,
      message: descriptor.message || descriptor.error || "Unknown batchPlay error",
      descriptor
    });
  }

  return errors;
}

function formatBatchPlayErrorMessage(context, errors) {
  const ctx = context?.op ? ` op=${context.op}` : "";
  const suffix = errors
    .map((item) => {
      const code = item.result !== undefined ? ` result=${item.result}` : "";
      return `#${item.index}${code} ${item.message}`;
    })
    .join(" | ");
  return `batchPlay failed${ctx}: ${suffix}`;
}

async function runBatchPlay(commands, options, context) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error("batchPlay commands[] must be a non-empty array");
  }

  const mergedOptions = {
    ...DEFAULT_BATCHPLAY_OPTIONS,
    ...(options || {})
  };

  let descriptors;

  try {
    descriptors = await action.batchPlay(commands, mergedOptions);
  } catch (error) {
    const detail = sanitizeError(error);
    const message = `batchPlay threw${context?.op ? ` op=${context.op}` : ""}: ${detail.message}`;
    const wrapped = new Error(message);
    wrapped.originalError = detail;
    throw wrapped;
  }

  const embeddedErrors = descriptorErrorItems(descriptors);
  if (embeddedErrors.length > 0) {
    const wrapped = new Error(formatBatchPlayErrorMessage(context, embeddedErrors));
    wrapped.descriptors = cloneSerializable(descriptors);
    throw wrapped;
  }

  return descriptors;
}

function normalizeLayerIdCandidate(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return undefined;
  }
  if (Array.isArray(rawValue)) {
    for (const item of rawValue) {
      const normalized = normalizeLayerIdCandidate(item);
      if (normalized !== undefined) {
        return normalized;
      }
    }
    return undefined;
  }
  const numeric = Number(rawValue);
  if (Number.isFinite(numeric)) {
    return String(Math.trunc(numeric));
  }
  if (typeof rawValue === "string" && rawValue.trim() !== "") {
    return rawValue.trim();
  }
  return undefined;
}

async function getActiveLayerId(doc) {
  try {
    const descriptors = await runBatchPlay(
      [
        {
          _obj: "get",
          _target: [
            {
              _property: "layerID"
            },
            {
              _ref: "layer",
              _enum: "ordinal",
              _value: "targetEnum"
            }
          ],
          _options: {
            dialogOptions: "dontDisplay"
          }
        }
      ],
      undefined,
      { op: "activeLayer.getId" }
    );
    return normalizeLayerIdCandidate(descriptors?.[0]?.layerID);
  } catch {
    const activeLayer = doc?.activeLayers?.[0];
    return activeLayer ? String(activeLayer.id) : undefined;
  }
}

async function layerHasUserMask(layer) {
  if (!layer) {
    return false;
  }
  if (typeof layer.hasUserMask === "boolean") {
    return layer.hasUserMask;
  }

  try {
    const descriptors = await runBatchPlay(
      [
        {
          _obj: "get",
          _target: [
            {
              _property: "hasUserMask"
            },
            {
              _ref: "layer",
              _id: Number(layer.id)
            }
          ],
          _options: {
            dialogOptions: "dontDisplay"
          }
        }
      ],
      undefined,
      { op: "layer.hasUserMask" }
    );
    const descriptor = descriptors?.[0] || {};
    if (typeof descriptor.hasUserMask === "boolean") {
      return descriptor.hasUserMask;
    }
    if (typeof descriptor.userMaskEnabled === "boolean") {
      return descriptor.userMaskEnabled;
    }
  } catch {
    // If inspection fails, fall back to attempting operation handlers.
  }

  return false;
}

function canonicalOpKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function registerOp(names, handler) {
  const aliases = Array.isArray(names) ? names : [names];
  const primary = aliases[0];
  const activeDocumentOptional = primary === "createDocument" || primary === "openDocument";

  for (const alias of aliases) {
    const key = canonicalOpKey(alias);
    OP_ALIAS_TABLE.set(key, primary);
    OP_HANDLER_TABLE.set(primary, handler);
  }

  if (!activeDocumentOptional) {
    OP_REQUIRES_ACTIVE_DOCUMENT.add(primary);
  }
}

function resolveOperationName(rawName) {
  const key = canonicalOpKey(rawName);
  if (!key) {
    throw new Error("Operation name is required");
  }

  const primary = OP_ALIAS_TABLE.get(key);
  if (!primary) {
    throw new Error(`Unsupported op '${rawName}'`);
  }

  return primary;
}

function requireLayerTarget(op, refs, options = {}) {
  const layer = findLayer(op.target, refs, options);
  if (!layer) {
    throw new Error(`Target layer not found for op '${op.op}'`);
  }
  return layer;
}

function resolveLayerKind(rawKind) {
  if (!rawKind) {
    return constants?.LayerKind?.NORMAL;
  }
  return normalizeEnumLookup(constants?.LayerKind, rawKind, rawKind);
}

function resolveElementPlacement(rawPlacement) {
  if (!rawPlacement) {
    return undefined;
  }
  return normalizeEnumLookup(constants?.ElementPlacement, rawPlacement, rawPlacement);
}

function resolveBlendMode(rawBlendMode) {
  if (!rawBlendMode) {
    return undefined;
  }
  return normalizeEnumLookup(constants?.BlendMode, rawBlendMode, rawBlendMode);
}

function resolveRasterizeType(rawType) {
  if (!rawType) {
    return undefined;
  }
  return normalizeEnumLookup(constants?.RasterizeType, rawType, rawType);
}

function resolveAnchorPosition(rawAnchor) {
  if (!rawAnchor) {
    return undefined;
  }
  return normalizeEnumLookup(constants?.AnchorPosition, rawAnchor, rawAnchor);
}

function resolveFlipAxis(rawAxis) {
  if (!rawAxis) {
    return undefined;
  }
  return normalizeEnumLookup(constants?.FlipAxis, rawAxis, rawAxis);
}

function resolveSelectionType(rawType) {
  if (!rawType) {
    return constants?.SelectionType?.REPLACE;
  }
  return normalizeEnumLookup(constants?.SelectionType, rawType, rawType);
}

function resolveTrimType(rawType) {
  if (!rawType) {
    return constants?.TrimType?.TRANSPARENT || rawType;
  }
  return normalizeEnumLookup(constants?.TrimType, rawType, rawType);
}

function resolveSaveOption(rawOption) {
  const saveOptions = constants?.SaveOptions;

  if (rawOption === undefined || rawOption === null) {
    return saveOptions?.PROMPTTOSAVECHANGES;
  }

  if (typeof rawOption === "boolean") {
    return rawOption ? saveOptions?.SAVECHANGES : saveOptions?.DONOTSAVECHANGES;
  }

  const normalized = String(rawOption).trim().toLowerCase();
  if (normalized === "save" || normalized === "savechanges") {
    return saveOptions?.SAVECHANGES;
  }
  if (normalized === "discard" || normalized === "dontsave" || normalized === "donotsavechanges") {
    return saveOptions?.DONOTSAVECHANGES;
  }
  if (normalized === "prompt") {
    return saveOptions?.PROMPTTOSAVECHANGES;
  }

  return normalizeEnumLookup(saveOptions, rawOption, rawOption);
}

async function runCreateDocument(op, ctx) {
  const options = {};
  if (op.name) options.name = String(op.name);
  if (Number.isFinite(Number(op.width))) options.width = Number(op.width);
  if (Number.isFinite(Number(op.height))) options.height = Number(op.height);
  if (Number.isFinite(Number(op.resolution))) options.resolution = Number(op.resolution);
  if (Number.isFinite(Number(op.depth))) options.depth = Number(op.depth);
  if (op.mode) options.mode = String(op.mode);
  if (op.fill) options.fill = String(op.fill);
  if (op.preset) options.preset = String(op.preset);
  if (op.profile) options.profile = String(op.profile);

  if (typeof app.createDocument !== "function") {
    throw new Error("Photoshop createDocument() API unavailable in this version");
  }

  const document = await app.createDocument(options);

  return {
    document: serializeDocument(document),
    refValue: buildDocumentRefValue(document),
    detail: `Created document '${document.title}'`
  };
}

async function runOpenDocumentOp(op, _ctx) {
  const rawInput = op.input ?? op.path ?? op.source;
  if (!rawInput) {
    throw new Error("openDocument op requires input/path/source");
  }

  const input = String(rawInput);
  let openArg = input;

  if (isLikelyPath(input)) {
    try {
      openArg = await getEntryFromPath(input);
    } catch (error) {
      throw new Error(`openDocument failed to resolve path '${input}': ${error?.message || String(error)}`);
    }
  }

  const document = await app.open(openArg);
  return {
    document: serializeDocument(document),
    refValue: buildDocumentRefValue(document),
    detail: `Opened document '${document.title}'`
  };
}

async function runDuplicateDocument(op, ctx) {
  const doc = findDocument(op.docRef || op.target || "active", ctx.refs);
  if (!doc) {
    throw new Error("duplicateDocument target doc not found");
  }

  const duplicated = await doc.duplicate(op.name ? String(op.name) : undefined, Boolean(op.mergeLayersOnly));
  return {
    document: serializeDocument(duplicated),
    refValue: buildDocumentRefValue(duplicated),
    detail: `Duplicated document '${doc.title}'`
  };
}

function resolveSaveFormat(op) {
  if (op.format) {
    return String(op.format).toLowerCase();
  }

  if (typeof op.output === "string") {
    const match = op.output.match(/\.([a-z0-9]+)$/i);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return "psd";
}

function normalizeSaveMethod(format) {
  const lowered = String(format || "psd").toLowerCase();
  if (lowered === "jpeg") return "jpg";
  return lowered;
}

function hasDocumentFilePath(doc) {
  if (!doc) {
    return false;
  }

  try {
    const pathValue = doc.path;
    if (!pathValue) {
      return false;
    }
    if (typeof pathValue === "string") {
      return pathValue.trim().length > 0;
    }
    if (typeof pathValue.nativePath === "string" && pathValue.nativePath.trim().length > 0) {
      return true;
    }
    if (typeof pathValue.name === "string" && pathValue.name.trim().length > 0) {
      return true;
    }
    return true;
  } catch {
    return false;
  }
}

async function runSaveDocument(op, ctx) {
  const doc = findDocument(op.docRef || op.target || "active", ctx.refs);
  if (!doc) {
    throw new Error("saveDocument target doc not found");
  }

  if (!op.output) {
    if (!hasDocumentFilePath(doc) && op.allowDialog !== true) {
      return {
        document: serializeDocument(doc),
        skipped: true,
        detail: "Document has no saved path; skipped saveDocument to avoid Save As dialog. Use saveDocumentAs with output."
      };
    }

    await doc.save();
    return {
      document: serializeDocument(doc),
      detail: `Saved document '${doc.title}'`
    };
  }

  const output = String(op.output);
  const fileEntry = await getFileEntryForSave(output);
  const format = normalizeSaveMethod(resolveSaveFormat(op));

  const saveAs = doc.saveAs;
  if (!saveAs || typeof saveAs[format] !== "function") {
    throw new Error(`saveDocument format '${format}' unsupported by UXP saveAs API`);
  }

  const saveOptions = op.options && typeof op.options === "object" ? op.options : {};

  if (format === "jpg") {
    const quality = toFiniteNumber(op.quality, undefined);
    if (quality !== undefined && saveOptions.quality === undefined) {
      saveOptions.quality = Math.max(0, Math.min(12, quality > 12 ? Math.round(quality / 8.3333) : quality));
    }
  }

  await saveAs[format](fileEntry, saveOptions, Boolean(op.asCopy !== false));

  return {
    document: serializeDocument(doc),
    output: fileEntry.nativePath || output,
    format,
    detail: `Saved ${format.toUpperCase()} '${fileEntry.nativePath || output}'`
  };
}

async function runSaveDocumentAs(op, ctx) {
  if (!op.output) {
    throw new Error("saveDocumentAs requires output");
  }
  return runSaveDocument(op, ctx);
}

async function runCloseDocument(op, ctx) {
  const doc = findDocument(op.docRef || op.target || "active", ctx.refs);
  if (!doc) {
    throw new Error("closeDocument target doc not found");
  }
  const docTitle = doc.title;

  if (op.save === false || op.saveChanges === false || op.mode === "discard") {
    if (typeof doc.closeWithoutSaving === "function") {
      doc.closeWithoutSaving();
    } else {
      await doc.close(resolveSaveOption(false));
    }

    return {
      detail: `Closed document '${docTitle}' without saving`
    };
  }

  if (op.save === true && op.output) {
    await runSaveDocument({
      ...op,
      target: op.target || op.docRef || "active"
    }, ctx);
  }

  await doc.close(resolveSaveOption(op.saveOption || op.mode || op.save));

  return {
    detail: `Closed document '${docTitle}'`
  };
}

async function runResizeImage(op, ctx) {
  const doc = findDocument(op.docRef || op.target || "active", ctx.refs) || activeDocumentOrThrow();
  const width = toFiniteNumber(op.width, undefined);
  const height = toFiniteNumber(op.height, undefined);

  if (!Number.isFinite(width) && !Number.isFinite(height)) {
    throw new Error("resizeImage requires width and/or height");
  }

  await doc.resizeImage(width, height);

  if (Number.isFinite(Number(op.resolution))) {
    doc.resolution = Number(op.resolution);
  }

  return {
    document: serializeDocument(doc),
    detail: `Resized image to ${String(width || "auto")}x${String(height || "auto")}`
  };
}

async function runResizeCanvas(op, ctx) {
  const doc = findDocument(op.docRef || op.target || "active", ctx.refs) || activeDocumentOrThrow();
  const width = toFiniteNumber(op.width, undefined);
  const height = toFiniteNumber(op.height, undefined);

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("resizeCanvas requires numeric width and height");
  }

  await doc.resizeCanvas(width, height, resolveAnchorPosition(op.anchor));

  return {
    document: serializeDocument(doc),
    detail: `Resized canvas to ${width}x${height}`
  };
}

async function runCropDocument(op, ctx) {
  const doc = findDocument(op.docRef || op.target || "active", ctx.refs) || activeDocumentOrThrow();
  const boundsSource = op.bounds && typeof op.bounds === "object" ? op.bounds : op;
  const left = Number(boundsSource.left);
  const top = Number(boundsSource.top);
  const right = Number(boundsSource.right);
  const bottom = Number(boundsSource.bottom);

  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    throw new Error("cropDocument requires bounds {left,top,right,bottom}");
  }

  await doc.crop(
    {
      left,
      top,
      right,
      bottom
    },
    toFiniteNumber(op.angle, undefined),
    toFiniteNumber(op.width, undefined),
    toFiniteNumber(op.height, undefined)
  );

  return {
    document: serializeDocument(doc),
    detail: "Cropped document"
  };
}

async function runFlattenDocument(op, ctx) {
  const doc = findDocument(op.docRef || op.target || "active", ctx.refs) || activeDocumentOrThrow();
  await doc.flatten();
  return {
    document: serializeDocument(doc),
    detail: "Flattened document"
  };
}

async function runMergeVisible(op, ctx) {
  const doc = findDocument(op.docRef || op.target || "active", ctx.refs) || activeDocumentOrThrow();
  await doc.mergeVisibleLayers();
  return {
    document: serializeDocument(doc),
    detail: "Merged visible layers"
  };
}

async function runTrimDocument(op, ctx) {
  const doc = findDocument(op.docRef || op.target || "active", ctx.refs) || activeDocumentOrThrow();

  await doc.trim(
    resolveTrimType(op.trimType),
    op.top !== undefined ? Boolean(op.top) : true,
    op.left !== undefined ? Boolean(op.left) : true,
    op.bottom !== undefined ? Boolean(op.bottom) : true,
    op.right !== undefined ? Boolean(op.right) : true
  );

  return {
    document: serializeDocument(doc),
    detail: "Trimmed document"
  };
}

async function runRotateDocument(op, ctx) {
  const doc = findDocument(op.docRef || op.target || "active", ctx.refs) || activeDocumentOrThrow();
  const angle = toFiniteNumber(op.angle, undefined);
  if (!Number.isFinite(angle)) {
    throw new Error("rotateDocument requires numeric angle");
  }

  await doc.rotate(angle, resolveAnchorPosition(op.anchor), op.options || {});

  return {
    document: serializeDocument(doc),
    detail: `Rotated document by ${angle}deg`
  };
}

async function runCreateLayer(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const kind = resolveLayerKind(op.kind);
  const options = {};

  if (op.name !== undefined) options.name = String(op.name);
  if (op.opacity !== undefined) options.opacity = Number(op.opacity);
  if (op.blendMode !== undefined) options.blendMode = resolveBlendMode(op.blendMode);
  if (op.fillNeutral !== undefined) options.fillNeutral = Boolean(op.fillNeutral);

  let layer;
  if (typeof doc.createLayer === "function") {
    if (kind !== undefined || Object.keys(options).length > 0) {
      layer = await doc.createLayer(kind, options);
    } else {
      layer = await doc.createLayer();
    }
  } else if (doc.layers && typeof doc.layers.add === "function") {
    layer = await doc.layers.add();
    if (options.name) layer.name = options.name;
  } else {
    throw new Error("createLayer API unavailable");
  }

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Created layer '${layer.name}'`
  };
}

async function runCreatePixelLayer(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();

  if (typeof doc.createPixelLayer !== "function") {
    return runCreateLayer({ ...op, kind: op.kind || "normal" }, ctx);
  }

  const options = {};
  if (op.name !== undefined) options.name = String(op.name);
  if (op.opacity !== undefined) options.opacity = Number(op.opacity);
  if (op.blendMode !== undefined) options.blendMode = resolveBlendMode(op.blendMode);
  if (op.fillNeutral !== undefined) options.fillNeutral = Boolean(op.fillNeutral);

  const layer = await doc.createPixelLayer(options);
  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Created pixel layer '${layer.name}'`
  };
}

async function runCreateGroup(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();

  if (typeof doc.createLayerGroup === "function") {
    const options = {};
    if (op.name !== undefined) options.name = String(op.name);
    if (op.opacity !== undefined) options.opacity = Number(op.opacity);
    if (op.blendMode !== undefined) options.blendMode = resolveBlendMode(op.blendMode);

    if (Array.isArray(op.fromLayers) && op.fromLayers.length > 0) {
      options.fromLayers = op.fromLayers.map((target) => {
        const layer = findLayer(target, ctx.refs);
        if (!layer) {
          throw new Error("createGroup fromLayers target not found");
        }
        return layer;
      });
    }

    const group = await doc.createLayerGroup(options);

    return {
      layer: serializeLayer(group),
      refValue: buildLayerRefValue(group),
      detail: `Created group '${group.name}'`
    };
  }

  return runCreateLayer({ ...op, kind: "group" }, ctx);
}

async function runGroupLayers(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const targets = Array.isArray(op.targets) ? op.targets : [];
  if (targets.length === 0) {
    throw new Error("groupLayers requires targets[]");
  }

  const layers = targets.map((target) => {
    const layer = findLayer(target, ctx.refs);
    if (!layer) {
      throw new Error("groupLayers target layer not found");
    }
    return layer;
  });

  const group = await doc.groupLayers(layers);
  if (op.name) {
    group.name = String(op.name);
  }

  return {
    layer: serializeLayer(group),
    refValue: buildLayerRefValue(group),
    detail: `Grouped ${layers.length} layers`
  };
}

async function runUngroupLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const layerName = layer.name;
  await selectLayer(layer);

  await runBatchPlay(
    [
      {
        _obj: "ungroupLayersEvent",
        _target: [
          {
            _ref: "layer",
            _enum: "ordinal",
            _value: "targetEnum"
          }
        ],
        _options: {
          dialogOptions: "dontDisplay"
        }
      }
    ],
    undefined,
    { op: "ungroupLayer" }
  );

  return {
    detail: `Ungrouped '${layerName}'`
  };
}

async function runDeleteLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const layerName = layer.name;

  if (typeof layer.delete === "function") {
    try {
      layer.delete();
    } catch (error) {
      const detail = sanitizeError(error);
      if (/not currently available/i.test(detail.message)) {
        return {
          detail: `Delete unavailable for '${layerName}' (skipped)`
        };
      }
      throw error;
    }
  } else {
    try {
      await runBatchPlay(
        [
          {
            _obj: "delete",
            _target: [
              {
                _ref: "layer",
                _id: Number(layer.id)
              }
            ]
          }
        ],
        undefined,
        { op: "deleteLayer" }
      );
    } catch (error) {
      const detail = sanitizeError(error);
      if (/not currently available/i.test(detail.message)) {
        return {
          detail: `Delete unavailable for '${layerName}' (skipped)`
        };
      }
      throw error;
    }
  }

  return {
    detail: `Deleted layer '${layerName}'`
  };
}

async function runRenameLayer(op, ctx) {
  if (typeof op.name !== "string" || op.name.trim() === "") {
    throw new Error("renameLayer requires non-empty name");
  }

  const layer = requireLayerTarget(op, ctx.refs);
  layer.name = op.name;

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Renamed layer to '${layer.name}'`
  };
}

async function runDuplicateLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);

  let relativeObject;
  if (op.relativeTo !== undefined) {
    relativeObject = findLayer(op.relativeTo, ctx.refs) || findDocument(op.relativeTo, ctx.refs);
    if (!relativeObject) {
      throw new Error("duplicateLayer relativeTo target not found");
    }
  }

  const duplicated = await layer.duplicate(relativeObject, resolveElementPlacement(op.insertionLocation || op.placement), op.name);

  return {
    layer: serializeLayer(duplicated),
    refValue: buildLayerRefValue(duplicated),
    detail: `Duplicated layer '${layer.name}'`
  };
}

async function runSelectLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  await selectLayer(layer);

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Selected layer '${layer.name}'`
  };
}

async function runSelectLayers(op, ctx) {
  if (!Array.isArray(op.targets) || op.targets.length === 0) {
    throw new Error("selectLayers requires targets[]");
  }

  const layers = op.targets.map((target) => {
    const layer = findLayer(target, ctx.refs);
    if (!layer) {
      throw new Error("selectLayers target layer not found");
    }
    return layer;
  });

  const doc = activeDocumentOrThrow();
  doc.activeLayers = layers;

  return {
    detail: `Selected ${layers.length} layer(s)`,
    layers: layers.map(serializeLayer),
    refValue: buildLayerRefValue(layers[0])
  };
}

async function runMoveLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const normalizedIndex = Number.isFinite(Number(op.index)) ? Number(op.index) : Number.isFinite(Number(op.at)) ? Number(op.at) : undefined;

  if (op.by && (op.by.x !== undefined || op.by.y !== undefined)) {
    const x = op.by.x !== undefined ? op.by.x : 0;
    const y = op.by.y !== undefined ? op.by.y : 0;
    await layer.translate(x, y);
    return {
      layer: serializeLayer(layer),
      refValue: buildLayerRefValue(layer),
      detail: `Translated layer '${layer.name}' by (${x},${y})`
    };
  }

  if (op.relativeTo !== undefined) {
    const relativeLayer = findLayer(op.relativeTo, ctx.refs);
    if (!relativeLayer) {
      throw new Error("moveLayer relativeTo target not found");
    }

    try {
      layer.move(relativeLayer, resolveElementPlacement(op.insertLocation || op.placement || "placeAfter"));
    } catch (error) {
      const detail = sanitizeError(error);
      if (/not currently available/i.test(detail.message)) {
        return {
          layer: serializeLayer(layer),
          refValue: buildLayerRefValue(layer),
          detail: `Move unavailable for '${layer.name}' (skipped)`
        };
      }
      throw error;
    }
    return {
      layer: serializeLayer(layer),
      refValue: buildLayerRefValue(layer),
      detail: `Moved layer '${layer.name}' relative to '${relativeLayer.name}'`
    };
  }

  const to = String(op.to || "").trim().toLowerCase();
  if (to === "front" || to === "top") {
    layer.bringToFront();
    return {
      layer: serializeLayer(layer),
      refValue: buildLayerRefValue(layer),
      detail: `Moved layer '${layer.name}' to front`
    };
  }

  if (to === "back" || to === "bottom") {
    layer.sendToBack();
    return {
      layer: serializeLayer(layer),
      refValue: buildLayerRefValue(layer),
      detail: `Moved layer '${layer.name}' to back`
    };
  }

  if (Number.isFinite(normalizedIndex)) {
    const doc = activeDocumentOrThrow();
    const rootLayers = Array.from(doc.layers || []);
    if (rootLayers.length <= 1) {
      return {
        layer: serializeLayer(layer),
        refValue: buildLayerRefValue(layer),
        detail: `Layer stack has <= 1 layer; no move required`
      };
    }

    const currentIndex = rootLayers.findIndex((candidate) => String(candidate.id) === String(layer.id));
    if (currentIndex < 0) {
      throw new Error(`moveLayer index target '${layer.name}' is not in root layer stack`);
    }

    const targetIndex = Math.max(0, Math.min(rootLayers.length - 1, Math.trunc(normalizedIndex)));
    if (targetIndex === currentIndex) {
      return {
        layer: serializeLayer(layer),
        refValue: buildLayerRefValue(layer),
        detail: `Layer '${layer.name}' already at index ${targetIndex}`
      };
    }

    if (targetIndex === 0) {
      layer.bringToFront();
    } else if (targetIndex === rootLayers.length - 1) {
      layer.sendToBack();
    } else {
      const stackWithoutLayer = rootLayers.filter((candidate) => String(candidate.id) !== String(layer.id));
      const anchor = stackWithoutLayer[targetIndex];
      if (!anchor) {
        layer.sendToBack();
      } else {
        const placement = targetIndex < currentIndex ? resolveElementPlacement("placeBefore") : resolveElementPlacement("placeAfter");
        layer.move(anchor, placement);
      }
    }

    return {
      layer: serializeLayer(layer),
      refValue: buildLayerRefValue(layer),
      detail: `Moved layer '${layer.name}' to index ${targetIndex}`
    };
  }

  throw new Error("moveLayer requires by{x,y}, relativeTo+placement, to(front/back), or index");
}

async function runSetLayerVisibility(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  if (op.visible === undefined) {
    throw new Error("setLayerVisibility requires visible=true|false");
  }
  layer.visible = Boolean(op.visible);

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Layer '${layer.name}' visibility=${String(layer.visible)}`
  };
}

async function runShowLayer(op, ctx) {
  return runSetLayerVisibility(
    {
      ...op,
      visible: true
    },
    ctx
  );
}

async function runHideLayer(op, ctx) {
  return runSetLayerVisibility(
    {
      ...op,
      visible: false
    },
    ctx
  );
}

async function runSetLayerOpacity(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  if (!Number.isFinite(Number(op.opacity))) {
    throw new Error("setLayerOpacity requires numeric opacity");
  }

  layer.opacity = Number(op.opacity);

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Layer '${layer.name}' opacity=${layer.opacity}`
  };
}

async function runSetBlendMode(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  if (!op.blendMode) {
    throw new Error("setBlendMode requires blendMode");
  }

  layer.blendMode = resolveBlendMode(op.blendMode);

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Layer '${layer.name}' blendMode=${String(layer.blendMode)}`
  };
}

async function runSetLayerProps(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);

  if (typeof op.visible === "boolean") {
    layer.visible = op.visible;
  }
  if (typeof op.locked === "boolean") {
    layer.locked = op.locked;
  }
  if (op.opacity !== undefined) {
    if (!Number.isFinite(Number(op.opacity))) {
      throw new Error("setLayerProps opacity must be numeric");
    }
    layer.opacity = Math.max(0, Math.min(100, Number(op.opacity)));
  }
  if (op.blendMode) {
    layer.blendMode = resolveBlendMode(op.blendMode);
  }

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Updated layer properties '${layer.name}'`
  };
}

async function runBringLayerToFront(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  layer.bringToFront();

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Moved layer '${layer.name}' to front`
  };
}

async function runSendLayerToBack(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  layer.sendToBack();

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Moved layer '${layer.name}' to back`
  };
}

async function runMergeLayer(op, ctx) {
  const doc = activeDocumentOrThrow();

  if (Array.isArray(op.targets) && op.targets.length > 0) {
    const layers = op.targets.map((target) => {
      const layer = findLayer(target, ctx.refs);
      if (!layer) {
        throw new Error("mergeLayer target not found");
      }
      return layer;
    });

    const beforeLayerIds = new Set(flattenLayers(doc.layers || []).map((candidate) => String(candidate.id)));
    doc.activeLayers = layers;
    await runBatchPlay(
      [
        {
          _obj: "mergeLayersNew",
          _options: {
            dialogOptions: "dontDisplay"
          }
        }
      ],
      undefined,
      { op: "mergeLayers" }
    );
    const afterLayers = flattenLayers(doc.layers || []);
    const mergedFromDiff = afterLayers.find((candidate) => !beforeLayerIds.has(String(candidate.id)));
    const activeLayerId = await getActiveLayerId(doc);
    const mergedFromActiveId = activeLayerId ? findLayer({ layerId: activeLayerId }, ctx.refs, { doc }) : null;
    const merged = mergedFromActiveId || mergedFromDiff || doc.activeLayers?.[0] || findLayer({ layerName: layers[0].name }, ctx.refs, { doc }) || layers[0];
    if (op.name && merged) {
      merged.name = String(op.name);
    }
    return {
      layer: serializeLayer(merged),
      refValue: buildLayerRefValue(merged),
      detail: `Merged ${layers.length} selected layers`
    };
  }

  const layer = requireLayerTarget(op, ctx.refs);
  await selectLayer(layer);
  const merged = await layer.merge();

  return {
    layer: serializeLayer(merged),
    refValue: buildLayerRefValue(merged),
    detail: `Merged layer '${layer.name}'`
  };
}

async function runRasterizeLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  await layer.rasterize(resolveRasterizeType(op.rasterizeType || op.targetType));

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Rasterized layer '${layer.name}'`
  };
}

async function runLinkLayers(op, ctx) {
  const source = requireLayerTarget(op, ctx.refs);
  const targets = Array.isArray(op.targets) ? op.targets : [];
  if (targets.length === 0) {
    throw new Error("linkLayers requires targets[]");
  }

  let linked = null;
  for (const target of targets) {
    const targetLayer = findLayer(target, ctx.refs);
    if (!targetLayer) {
      throw new Error("linkLayers target not found");
    }
    linked = source.link(targetLayer);
  }

  return {
    layer: serializeLayer(source),
    linkedLayers: Array.isArray(linked) ? linked.map(serializeLayer) : undefined,
    refValue: buildLayerRefValue(source),
    detail: `Linked layer '${source.name}' to ${targets.length} layer(s)`
  };
}

async function runUnlinkLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  await layer.unlink();

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Unlinked layer '${layer.name}'`
  };
}

async function runTranslateLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);

  const horizontal = op.horizontal !== undefined ? op.horizontal : op.x !== undefined ? op.x : op.by?.x;
  const vertical = op.vertical !== undefined ? op.vertical : op.y !== undefined ? op.y : op.by?.y;

  if (horizontal === undefined && vertical === undefined) {
    throw new Error("translateLayer requires horizontal/vertical or x/y");
  }

  await layer.translate(horizontal !== undefined ? horizontal : 0, vertical !== undefined ? vertical : 0);

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Translated layer '${layer.name}'`
  };
}

async function runScaleLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const width = toFiniteNumber(op.width ?? op.scaleX ?? op.scale ?? op.percent, undefined);
  const height = toFiniteNumber(op.height ?? op.scaleY ?? op.scale ?? op.percent, undefined);

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("scaleLayer requires width/height or scaleX/scaleY percentages");
  }

  await layer.scale(width, height, resolveAnchorPosition(op.anchor), op.options || {});

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Scaled layer '${layer.name}'`
  };
}

async function runRotateLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const angle = toFiniteNumber(op.angle, undefined);
  if (!Number.isFinite(angle)) {
    throw new Error("rotateLayer requires numeric angle");
  }

  await layer.rotate(angle, resolveAnchorPosition(op.anchor), op.options || {});

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Rotated layer '${layer.name}' by ${angle}deg`
  };
}

async function runFlipLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const axis = resolveFlipAxis(op.axis || "horizontal");
  if (!axis) {
    throw new Error("flipLayer requires axis");
  }

  await layer.flip(axis);

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Flipped layer '${layer.name}'`
  };
}

async function runSkewLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const angleH = toFiniteNumber(op.angleH ?? op.horizontal, undefined);
  const angleV = toFiniteNumber(op.angleV ?? op.vertical, undefined);

  if (!Number.isFinite(angleH) && !Number.isFinite(angleV)) {
    throw new Error("skewLayer requires angleH and/or angleV");
  }

  await layer.skew(angleH || 0, angleV || 0, op.options || {});

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Skewed layer '${layer.name}'`
  };
}

async function runTransformLayer(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const useAbsolutePosition = shouldUseAbsoluteTransformPosition(op);
  const absolutePosition = useAbsolutePosition ? resolveAbsoluteTransformPosition(op) : null;

  if (!useAbsolutePosition && (op.translate || op.by || op.x !== undefined || op.y !== undefined || op.horizontal !== undefined || op.vertical !== undefined)) {
    await runTranslateLayer({
      ...op,
      target: buildLayerRefValue(layer)
    }, ctx);
  }

  if (op.scale !== undefined || op.scaleX !== undefined || op.scaleY !== undefined || op.width !== undefined || op.height !== undefined || op.percent !== undefined) {
    await runScaleLayer({
      ...op,
      target: buildLayerRefValue(layer)
    }, ctx);
  }

  if (op.angle !== undefined || op.rotate !== undefined) {
    await runRotateLayer({
      ...op,
      angle: op.angle !== undefined ? op.angle : op.rotate,
      target: buildLayerRefValue(layer)
    }, ctx);
  }

  if (op.flip !== undefined || op.axis !== undefined) {
    await runFlipLayer({
      ...op,
      axis: op.axis || op.flip,
      target: buildLayerRefValue(layer)
    }, ctx);
  }

  if (op.skewX !== undefined || op.skewY !== undefined || op.angleH !== undefined || op.angleV !== undefined) {
    await runSkewLayer({
      ...op,
      angleH: op.angleH !== undefined ? op.angleH : op.skewX,
      angleV: op.angleV !== undefined ? op.angleV : op.skewY,
      target: buildLayerRefValue(layer)
    }, ctx);
  }

  if (absolutePosition) {
    await moveLayerToAbsolutePosition(layer, absolutePosition);
  }

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Applied transform sequence on layer '${layer.name}'`
  };
}

function resolveAlignType(rawAxis) {
  const axis = String(rawAxis || "horizontalCenters").toLowerCase();
  if (axis === "left" || axis === "lefts") return "lefts";
  if (axis === "right" || axis === "rights") return "rights";
  if (axis === "top" || axis === "tops") return "tops";
  if (axis === "bottom" || axis === "bottoms") return "bottoms";
  if (axis === "verticalcenter" || axis === "verticalcenters") return "verticalCenters";
  return "horizontalCenters";
}

function resolveDistributeType(rawAxis) {
  const axis = String(rawAxis || "horizontal").toLowerCase();
  if (axis === "vertical" || axis === "verticalcenters") return "verticalCenters";
  if (axis === "lefts") return "lefts";
  if (axis === "rights") return "rights";
  if (axis === "tops") return "tops";
  if (axis === "bottoms") return "bottoms";
  return "horizontalCenters";
}

function boundsToRect(layer) {
  const b = layer?.bounds;
  if (!b || typeof b !== "object") {
    return null;
  }

  const left = toFiniteNumber(b.left?.value ?? b.left, undefined);
  const top = toFiniteNumber(b.top?.value ?? b.top, undefined);
  const right = toFiniteNumber(b.right?.value ?? b.right, undefined);
  const bottom = toFiniteNumber(b.bottom?.value ?? b.bottom, undefined);

  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    return null;
  }

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    centerX: left + (right - left) / 2,
    centerY: top + (bottom - top) / 2
  };
}

function documentRect(doc) {
  const width = getDocDimension(doc?.width);
  const height = getDocDimension(doc?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    centerX: width / 2,
    centerY: height / 2
  };
}

function rectFromSpec(spec) {
  if (!spec || typeof spec !== "object") {
    return null;
  }

  const left = toFiniteNumber(spec.left ?? spec.x, undefined);
  const top = toFiniteNumber(spec.top ?? spec.y, undefined);
  const right = toFiniteNumber(spec.right, undefined);
  const bottom = toFiniteNumber(spec.bottom, undefined);
  const width = toFiniteNumber(spec.width, undefined);
  const height = toFiniteNumber(spec.height, undefined);

  let resolvedLeft = left;
  let resolvedTop = top;
  let resolvedRight = right;
  let resolvedBottom = bottom;

  if (Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(width) && Number.isFinite(height)) {
    resolvedRight = left + width;
    resolvedBottom = top + height;
  } else if (!(Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(right) && Number.isFinite(bottom))) {
    return null;
  }

  if (!Number.isFinite(resolvedLeft) || !Number.isFinite(resolvedTop) || !Number.isFinite(resolvedRight) || !Number.isFinite(resolvedBottom)) {
    return null;
  }
  if (resolvedRight <= resolvedLeft || resolvedBottom <= resolvedTop) {
    return null;
  }

  const resolvedWidth = resolvedRight - resolvedLeft;
  const resolvedHeight = resolvedBottom - resolvedTop;

  return {
    left: resolvedLeft,
    top: resolvedTop,
    right: resolvedRight,
    bottom: resolvedBottom,
    width: resolvedWidth,
    height: resolvedHeight,
    centerX: resolvedLeft + resolvedWidth / 2,
    centerY: resolvedTop + resolvedHeight / 2
  };
}

function resolveAlignment(rawAlignment, fallback = { x: 0.5, y: 0.5 }) {
  if (!rawAlignment) {
    return fallback;
  }

  const normalized = String(rawAlignment)
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  if (!normalized) {
    return fallback;
  }

  const tokens = normalized.split("-").filter(Boolean);
  if (tokens.length === 0) {
    return fallback;
  }

  let x;
  let y;
  const hasCenter = tokens.includes("center") || tokens.includes("middle") || tokens.includes("centre");

  if (tokens.includes("left")) x = 0;
  if (tokens.includes("right")) x = 1;
  if (tokens.includes("top")) y = 0;
  if (tokens.includes("bottom")) y = 1;

  if (hasCenter) {
    if (x === undefined) x = 0.5;
    if (y === undefined) y = 0.5;
  }

  return {
    x: x === undefined ? fallback.x : x,
    y: y === undefined ? fallback.y : y
  };
}

function resolveFitMode(rawMode, fallback = "none") {
  const mode = String(rawMode || "")
    .trim()
    .toLowerCase();

  if (!mode) {
    return fallback;
  }
  if (mode === "cover" || mode === "fill" || mode === "crop") {
    return "cover";
  }
  if (mode === "contain" || mode === "inside" || mode === "fit") {
    return "contain";
  }
  if (mode === "stretch" || mode === "distort" || mode === "exact") {
    return "stretch";
  }
  if (mode === "none" || mode === "off") {
    return "none";
  }
  return fallback;
}

function resolvePlaceAssetFitConfig(op, doc) {
  const canvasRect = documentRect(doc);
  const explicitRect = rectFromSpec(op.fitRect || op.frame || op.targetRect || op.bounds);
  const fitToCanvas =
    op.fitTo === "canvas" ||
    op.fitCanvas === true ||
    op.coverCanvas === true ||
    op.containCanvas === true;

  let mode = resolveFitMode(op.fit || op.mode, "");
  if (!mode) {
    if (op.coverCanvas === true) {
      mode = "cover";
    } else if (op.containCanvas === true) {
      mode = "contain";
    } else if (explicitRect || fitToCanvas) {
      mode = "contain";
    } else {
      mode = "none";
    }
  }

  const targetRect = explicitRect || (fitToCanvas || mode !== "none" ? canvasRect : null);
  if (!targetRect) {
    return null;
  }

  return {
    mode,
    targetRect,
    align: resolveAlignment(op.fitAlign || op.align, { x: 0.5, y: 0.5 })
  };
}

async function fitLayerToRect(layer, fitConfig, scaleOptions) {
  if (!layer || !fitConfig || fitConfig.mode === "none") {
    return {
      applied: false,
      detail: "fit skipped"
    };
  }

  const mode = fitConfig.mode;
  const targetRect = fitConfig.targetRect;
  const align = fitConfig.align || { x: 0.5, y: 0.5 };
  let currentRect = boundsToRect(layer);

  if (!currentRect || currentRect.width <= 0 || currentRect.height <= 0 || targetRect.width <= 0 || targetRect.height <= 0) {
    return {
      applied: false,
      detail: "fit skipped (invalid bounds)"
    };
  }

  let scaleX = 100;
  let scaleY = 100;
  if (mode === "cover") {
    const factor = Math.max(targetRect.width / currentRect.width, targetRect.height / currentRect.height);
    scaleX = factor * 100;
    scaleY = factor * 100;
  } else if (mode === "contain") {
    const factor = Math.min(targetRect.width / currentRect.width, targetRect.height / currentRect.height);
    scaleX = factor * 100;
    scaleY = factor * 100;
  } else if (mode === "stretch") {
    scaleX = (targetRect.width / currentRect.width) * 100;
    scaleY = (targetRect.height / currentRect.height) * 100;
  }

  if (Math.abs(scaleX - 100) > 0.05 || Math.abs(scaleY - 100) > 0.05) {
    await layer.scale(scaleX, scaleY, resolveAnchorPosition("middlecenter"), scaleOptions || {});
    currentRect = boundsToRect(layer) || currentRect;
  }

  const desiredLeft = targetRect.left + (targetRect.width - currentRect.width) * align.x;
  const desiredTop = targetRect.top + (targetRect.height - currentRect.height) * align.y;
  const dx = desiredLeft - currentRect.left;
  const dy = desiredTop - currentRect.top;

  if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
    await layer.translate(dx, dy);
    currentRect = boundsToRect(layer) || currentRect;
  }

  return {
    applied: true,
    bounds: currentRect,
    scaleX,
    scaleY,
    detail: `fit=${mode} align=${Math.round(align.x * 100)}/${Math.round(align.y * 100)}`
  };
}

function shouldUseAbsoluteTransformPosition(op) {
  if (op.absolute === true) {
    return true;
  }
  if (op.absolute === false) {
    return false;
  }
  if (op.position && typeof op.position === "object") {
    return true;
  }
  if (op.to && typeof op.to === "object") {
    return true;
  }
  if (op.x === undefined && op.y === undefined) {
    return false;
  }

  // Preserve legacy relative x/y behavior for plain translate-only payloads.
  const hasNonTranslationTransform =
    op.scale !== undefined ||
    op.scaleX !== undefined ||
    op.scaleY !== undefined ||
    op.width !== undefined ||
    op.height !== undefined ||
    op.percent !== undefined ||
    op.angle !== undefined ||
    op.rotate !== undefined ||
    op.flip !== undefined ||
    op.axis !== undefined ||
    op.skewX !== undefined ||
    op.skewY !== undefined ||
    op.angleH !== undefined ||
    op.angleV !== undefined;

  return hasNonTranslationTransform;
}

function resolveAbsoluteTransformPosition(op) {
  const source = (op.position && typeof op.position === "object" ? op.position : op.to && typeof op.to === "object" ? op.to : null) || op;
  const x = toFiniteNumber(source.x, undefined);
  const y = toFiniteNumber(source.y, undefined);
  if (!Number.isFinite(x) && !Number.isFinite(y)) {
    return null;
  }

  return {
    x,
    y,
    align: source.align || source.anchor || op.positionAnchor || op.anchorPoint || op.align || "top-left"
  };
}

async function moveLayerToAbsolutePosition(layer, positionSpec) {
  if (!layer || !positionSpec) {
    return false;
  }

  const rect = boundsToRect(layer);
  if (!rect) {
    return false;
  }

  const anchor = resolveAlignment(positionSpec.align, { x: 0, y: 0 });
  const currentX = rect.left + rect.width * anchor.x;
  const currentY = rect.top + rect.height * anchor.y;
  const targetX = Number.isFinite(positionSpec.x) ? positionSpec.x : currentX;
  const targetY = Number.isFinite(positionSpec.y) ? positionSpec.y : currentY;
  const dx = targetX - currentX;
  const dy = targetY - currentY;

  if (Math.abs(dx) <= 0.05 && Math.abs(dy) <= 0.05) {
    return false;
  }

  await layer.translate(dx, dy);
  return true;
}

function getTextFontSize(textItem) {
  if (!textItem) {
    return undefined;
  }
  const rawSize = textItem.characterStyle?.size ?? textItem.size;
  return toFiniteNumber(rawSize?.value ?? rawSize, undefined);
}

function setTextFontSize(textItem, size) {
  if (!textItem || !Number.isFinite(size) || size <= 0) {
    return false;
  }
  if (textItem.characterStyle && "size" in textItem.characterStyle) {
    textItem.characterStyle.size = size;
    return true;
  }
  if ("size" in textItem) {
    textItem.size = size;
    return true;
  }
  return false;
}

function rectsOverlap(a, b, gap = 0) {
  if (!a || !b) {
    return false;
  }
  return a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;
}

async function fitTextLayerBounds(layer, constraints) {
  const maxWidth = toFiniteNumber(constraints?.maxWidth, undefined);
  const maxHeight = toFiniteNumber(constraints?.maxHeight, undefined);
  const minFontSize = toFiniteNumber(constraints?.minFontSize, 8);

  if (!layer?.textItem || (!Number.isFinite(maxWidth) && !Number.isFinite(maxHeight))) {
    return {
      adjusted: false,
      iterations: 0
    };
  }

  let fontSize = getTextFontSize(layer.textItem);
  let bounds = boundsToRect(layer);
  if (!Number.isFinite(fontSize) || !bounds) {
    return {
      adjusted: false,
      iterations: 0
    };
  }

  let adjusted = false;
  let iterations = 0;

  while (
    bounds &&
    ((Number.isFinite(maxWidth) && bounds.width > maxWidth) || (Number.isFinite(maxHeight) && bounds.height > maxHeight)) &&
    fontSize > minFontSize &&
    iterations < 300
  ) {
    fontSize = Math.max(minFontSize, fontSize - 1);
    if (!setTextFontSize(layer.textItem, fontSize)) {
      break;
    }
    bounds = boundsToRect(layer);
    adjusted = true;
    iterations += 1;
  }

  return {
    adjusted,
    iterations,
    fontSize,
    bounds
  };
}

async function avoidLayerOverlaps(layer, targetSpecs, refs, options) {
  if (!layer || !Array.isArray(targetSpecs) || targetSpecs.length === 0) {
    return 0;
  }

  const gap = toFiniteNumber(options?.gap, 8);
  let moved = 0;

  for (const targetSpec of targetSpecs) {
    const target = findLayer(targetSpec, refs);
    if (!target || String(target.id) === String(layer.id)) {
      continue;
    }

    const layerRect = boundsToRect(layer);
    const targetRect = boundsToRect(target);
    if (!layerRect || !targetRect) {
      continue;
    }
    if (!rectsOverlap(layerRect, targetRect)) {
      continue;
    }

    const desiredTop = targetRect.bottom + gap;
    const dy = desiredTop - layerRect.top;
    if (Math.abs(dy) <= 0.05) {
      continue;
    }

    await layer.translate(0, dy);
    moved += 1;
  }

  return moved;
}

async function translateLayerBy(layer, dx, dy) {
  const tx = toFiniteNumber(dx, 0);
  const ty = toFiniteNumber(dy, 0);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    return false;
  }
  if (Math.abs(tx) < 0.0001 && Math.abs(ty) < 0.0001) {
    return false;
  }
  await layer.translate(tx, ty);
  return true;
}

function resolveTargetLayersForLayoutOps(op, ctx) {
  if (Array.isArray(op.targets) && op.targets.length > 0) {
    const layers = [];
    let missingTargets = 0;
    for (const target of op.targets) {
      const layer = findLayer(target, ctx.refs);
      if (!layer) {
        missingTargets += 1;
        continue;
      }
      layers.push(layer);
    }
    return { layers, missingTargets };
  }

  const doc = activeDocumentOrThrow();
  const active = Array.from(doc.activeLayers || []);
  if (active.length === 0) {
    throw new Error("No active layers for layout op");
  }
  return { layers: active, missingTargets: 0 };
}

async function runAlignLayers(op, ctx) {
  const alignType = resolveAlignType(op.axis || op.type);
  const { layers, missingTargets } = resolveTargetLayersForLayoutOps(op, ctx);
  if (layers.length < 2) {
    return { detail: `Align skipped: requires at least 2 layers (resolved=${layers.length}, missing=${missingTargets})` };
  }

  const anchor = layers[0];
  const anchorRect = boundsToRect(anchor);
  if (!anchorRect) {
    return { detail: "Align skipped: could not resolve anchor bounds" };
  }

  let moved = 0;
  let skipped = 0;
  for (const layer of layers.slice(1)) {
    const rect = boundsToRect(layer);
    if (!rect) {
      skipped += 1;
      continue;
    }

    let dx = 0;
    let dy = 0;
    if (alignType === "lefts") dx = anchorRect.left - rect.left;
    if (alignType === "rights") dx = anchorRect.right - rect.right;
    if (alignType === "tops") dy = anchorRect.top - rect.top;
    if (alignType === "bottoms") dy = anchorRect.bottom - rect.bottom;
    if (alignType === "verticalCenters") dy = anchorRect.centerY - rect.centerY;
    if (alignType === "horizontalCenters") dx = anchorRect.centerX - rect.centerX;

    try {
      if (await translateLayerBy(layer, dx, dy)) {
        moved += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return {
    detail: `Aligned layers (${alignType}); moved=${moved}; skipped=${skipped}; missing=${missingTargets}`
  };
}

async function runDistributeLayers(op, ctx) {
  const distributeType = resolveDistributeType(op.axis || op.type);
  const { layers, missingTargets } = resolveTargetLayersForLayoutOps(op, ctx);
  if (layers.length < 3) {
    return { detail: `Distribute skipped: requires at least 3 layers (resolved=${layers.length}, missing=${missingTargets})` };
  }

  const rects = layers.map((layer) => ({ layer, rect: boundsToRect(layer) })).filter((entry) => entry.rect);
  if (rects.length < 3) {
    return { detail: "Distribute skipped: insufficient measurable layer bounds" };
  }

  const vertical = distributeType === "verticalCenters" || distributeType === "tops" || distributeType === "bottoms";
  const axisKey =
    distributeType === "tops" ? "top" :
    distributeType === "bottoms" ? "bottom" :
    distributeType === "lefts" ? "left" :
    distributeType === "rights" ? "right" :
    vertical ? "centerY" : "centerX";

  rects.sort((a, b) => a.rect[axisKey] - b.rect[axisKey]);
  const start = rects[0].rect[axisKey];
  const end = rects[rects.length - 1].rect[axisKey];
  const spacing = (end - start) / (rects.length - 1);

  let moved = 0;
  let skipped = 0;
  for (let i = 1; i < rects.length - 1; i += 1) {
    const entry = rects[i];
    const current = entry.rect[axisKey];
    const target = start + spacing * i;
    const delta = target - current;
    try {
      if (vertical) {
        if (await translateLayerBy(entry.layer, 0, delta)) moved += 1;
      } else {
        if (await translateLayerBy(entry.layer, delta, 0)) moved += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return {
    detail: `Distributed layers (${distributeType}); moved=${moved}; skipped=${skipped}; missing=${missingTargets}`
  };
}

async function runPlaceAsset(op, ctx) {
  const input = op.input || op.path || op.source;
  if (!input) {
    throw new Error("placeAsset requires input path/token");
  }

  const resolvedInput = await resolveSessionTokenWithMetadata(input);
  const token = resolvedInput.token;
  await runBatchPlay(
    [
      {
        _obj: "placeEvent",
        null: {
          _path: token,
          _kind: "local"
        },
        linked: Boolean(op.linked),
        _options: {
          dialogOptions: "dontDisplay"
        }
      }
    ],
    undefined,
    { op: "placeAsset" }
  );

  const doc = activeDocumentOrThrow();
  const layer = doc.activeLayers[0];
  if (layer && op.name) {
    layer.name = String(op.name);
  }

  const notes = [];
  if (layer && op.normalizePixels !== false) {
    const sourceWidth = toFiniteNumber(resolvedInput?.metadata?.pixelWidth, undefined);
    const sourceHeight = toFiniteNumber(resolvedInput?.metadata?.pixelHeight, undefined);
    const layerRect = boundsToRect(layer);
    if (Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight) && layerRect && layerRect.width > 0 && layerRect.height > 0) {
      const scaleX = (sourceWidth / layerRect.width) * 100;
      const scaleY = (sourceHeight / layerRect.height) * 100;
      if (Math.abs(scaleX - 100) > 0.05 || Math.abs(scaleY - 100) > 0.05) {
        await layer.scale(scaleX, scaleY, resolveAnchorPosition("middlecenter"), op.transformOptions || {});
        notes.push(`normalized pixel size to ${Math.round(sourceWidth)}x${Math.round(sourceHeight)}`);
      }
    }
  }

  const fitConfig = layer ? resolvePlaceAssetFitConfig(op, doc) : null;
  if (layer && fitConfig) {
    const fitResult = await fitLayerToRect(layer, fitConfig, op.transformOptions || {});
    if (fitResult.applied) {
      notes.push(fitResult.detail);
    }
  }

  return {
    layer: serializeLayer(layer),
    refValue: layer ? buildLayerRefValue(layer) : undefined,
    detail: `Placed asset '${input}'${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`
  };
}

async function runConvertToSmartObject(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const sourceName = layer.name;
  await selectLayer(layer);

  await runBatchPlay(
    [
      {
        _obj: "newPlacedLayer"
      }
    ],
    undefined,
    { op: "convertToSmartObject" }
  );

  const converted = activeDocumentOrThrow().activeLayers[0] || layer;
  if (converted && sourceName && op.preserveName !== false) {
    converted.name = sourceName;
  }
  return {
    layer: serializeLayer(converted),
    refValue: buildLayerRefValue(converted),
    detail: `Converted layer '${sourceName}' to Smart Object`
  };
}

async function runReplaceSmartObject(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const sourceName = layer.name;
  const input = op.input || op.path || op.source;
  if (!input) {
    throw new Error("replaceSmartObject requires input path/token");
  }

  await selectLayer(layer);
  const token = await resolveSessionToken(input);

  const commandWithTarget = {
    _obj: "placedLayerReplaceContents",
    _target: [
      {
        _ref: "layer",
        _id: Number(layer.id)
      }
    ],
    null: {
      _kind: "local",
      _path: token
    },
    _isCommand: true,
    _options: {
      dialogOptions: "dontDisplay"
    }
  };

  if (Number.isFinite(Number(op.pageNumber))) {
    commandWithTarget.pageNumber = Number(op.pageNumber);
  }
  if (op.crop !== undefined) {
    commandWithTarget.crop = op.crop;
  }

  try {
    await runBatchPlay([commandWithTarget], undefined, { op: "replaceSmartObject" });
  } catch (error) {
    const detail = sanitizeError(error);
    if (!/not currently available/i.test(detail.message)) {
      throw error;
    }

    const commandWithoutTarget = cloneSerializable(commandWithTarget);
    delete commandWithoutTarget._target;
    await runBatchPlay([commandWithoutTarget], undefined, { op: "replaceSmartObject(retry-no-target)" });
  }

  const updated = activeDocumentOrThrow().activeLayers?.[0] || findLayer({ layerName: sourceName }, ctx.refs) || layer;
  if (updated && sourceName && op.preserveName !== false) {
    updated.name = sourceName;
  }

  return {
    layer: serializeLayer(updated),
    refValue: buildLayerRefValue(updated),
    detail: `Replaced Smart Object contents for '${sourceName}'`
  };
}

async function runRelinkSmartObject(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const sourceName = layer.name;
  const input = op.input || op.path || op.source;
  if (!input) {
    throw new Error("relinkSmartObject requires input path/token");
  }

  await selectLayer(layer);
  const token = await resolveSessionToken(input);

  await runBatchPlay(
    [
      {
        _obj: "placedLayerRelinkToFile",
        null: {
          _kind: "local",
          _path: token
        },
        _isCommand: true,
        _options: {
          dialogOptions: "dontDisplay"
        }
      }
    ],
    undefined,
    { op: "relinkSmartObject" }
  );

  const updated = activeDocumentOrThrow().activeLayers?.[0] || findLayer({ layerName: sourceName }, ctx.refs) || layer;
  if (updated && sourceName && op.preserveName !== false) {
    updated.name = sourceName;
  }

  return {
    layer: serializeLayer(updated),
    refValue: buildLayerRefValue(updated),
    detail: `Relinked Smart Object '${sourceName}'`
  };
}

async function runEditSmartObject(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  await selectLayer(layer);

  await runBatchPlay(
    [
      {
        _obj: "placedLayerEditContents",
        _isCommand: true,
        _options: {
          dialogOptions: "dontDisplay"
        }
      }
    ],
    undefined,
    { op: "editSmartObject" }
  );

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Opened Smart Object editor for '${layer.name}'`
  };
}

function selectionForDoc(doc) {
  if (!doc?.selection) {
    throw new Error("Selection API unavailable in current Photoshop version");
  }
  return doc.selection;
}

async function runSelectAll(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  await selectionForDoc(doc).selectAll();

  return {
    detail: "Selected all"
  };
}

async function runDeselect(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  await selectionForDoc(doc).deselect();

  return {
    detail: "Deselected"
  };
}

async function runInverseSelection(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  await selectionForDoc(doc).inverse();

  return {
    detail: "Inverted selection"
  };
}

async function runFeatherSelection(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const by = toFiniteNumber(op.by ?? op.radius, undefined);
  if (!Number.isFinite(by)) {
    throw new Error("featherSelection requires by or radius");
  }

  await selectionForDoc(doc).feather(by, Boolean(op.applyEffectAtCanvasBounds));

  return {
    detail: `Feathered selection by ${by}`
  };
}

async function runExpandSelection(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const by = toFiniteNumber(op.by, undefined);
  if (!Number.isFinite(by)) {
    throw new Error("expandSelection requires by");
  }

  await selectionForDoc(doc).expand(by, Boolean(op.applyEffectAtCanvasBounds));

  return {
    detail: `Expanded selection by ${by}`
  };
}

async function runContractSelection(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const by = toFiniteNumber(op.by, undefined);
  if (!Number.isFinite(by)) {
    throw new Error("contractSelection requires by");
  }

  await selectionForDoc(doc).contract(by, Boolean(op.applyEffectAtCanvasBounds));

  return {
    detail: `Contracted selection by ${by}`
  };
}

async function runGrowSelection(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const tolerance = toFiniteNumber(op.tolerance ?? op.by, undefined);
  if (!Number.isFinite(tolerance)) {
    throw new Error("growSelection requires tolerance/by");
  }

  await selectionForDoc(doc).grow(tolerance);

  return {
    detail: `Grew selection tolerance=${tolerance}`
  };
}

async function runSmoothSelection(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const radius = toFiniteNumber(op.radius, undefined);
  if (!Number.isFinite(radius)) {
    throw new Error("smoothSelection requires radius");
  }

  await selectionForDoc(doc).smooth(radius, Boolean(op.applyEffectAtCanvasBounds));

  return {
    detail: `Smoothed selection radius=${radius}`
  };
}

async function runSelectRectangle(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const bounds = op.bounds;
  if (!bounds) {
    throw new Error("selectRectangle requires bounds");
  }

  await selectionForDoc(doc).selectRectangle(
    {
      top: Number(bounds.top),
      left: Number(bounds.left),
      bottom: Number(bounds.bottom),
      right: Number(bounds.right)
    },
    resolveSelectionType(op.mode),
    toFiniteNumber(op.feather, 0),
    op.antiAlias !== undefined ? Boolean(op.antiAlias) : true
  );

  return {
    detail: "Selected rectangle"
  };
}

async function runSelectEllipse(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const bounds = op.bounds;
  if (!bounds) {
    throw new Error("selectEllipse requires bounds");
  }

  await selectionForDoc(doc).selectEllipse(
    {
      top: Number(bounds.top),
      left: Number(bounds.left),
      bottom: Number(bounds.bottom),
      right: Number(bounds.right)
    },
    resolveSelectionType(op.mode),
    toFiniteNumber(op.feather, 0),
    op.antiAlias !== undefined ? Boolean(op.antiAlias) : true
  );

  return {
    detail: "Selected ellipse"
  };
}

async function runSelectPolygon(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  if (!Array.isArray(op.points) || op.points.length < 3) {
    throw new Error("selectPolygon requires points[3+] array");
  }

  await selectionForDoc(doc).selectPolygon(
    op.points.map((point) => ({
      x: Number(point.x),
      y: Number(point.y)
    })),
    resolveSelectionType(op.mode),
    toFiniteNumber(op.feather, 0),
    op.antiAlias !== undefined ? Boolean(op.antiAlias) : true
  );

  return {
    detail: "Selected polygon"
  };
}

async function runSelectLayerPixels(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const layer = requireLayerTarget(op, ctx.refs, { doc });

  await selectionForDoc(doc).load(layer, resolveSelectionType(op.mode), Boolean(op.invert));

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Loaded selection from layer '${layer.name}'`
  };
}

async function runSetSelection(op, ctx) {
  const shape = String(op.shape || op.type || "rect").toLowerCase();

  if (shape === "rect" || shape === "rectangle") {
    const x = toFiniteNumber(op.x ?? op.left, undefined);
    const y = toFiniteNumber(op.y ?? op.top, undefined);
    const width = toFiniteNumber(op.width, undefined);
    const height = toFiniteNumber(op.height, undefined);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error("setSelection rectangle requires x,y,width,height");
    }
    return runSelectRectangle(
      {
        ...op,
        bounds: {
          left: x,
          top: y,
          right: x + width,
          bottom: y + height
        }
      },
      ctx
    );
  }

  if (shape === "ellipse" || shape === "circle") {
    const x = toFiniteNumber(op.x ?? op.left, undefined);
    const y = toFiniteNumber(op.y ?? op.top, undefined);
    const width = toFiniteNumber(op.width, undefined);
    const height = toFiniteNumber(op.height, undefined);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error("setSelection ellipse requires x,y,width,height");
    }
    return runSelectEllipse(
      {
        ...op,
        bounds: {
          left: x,
          top: y,
          right: x + width,
          bottom: y + height
        }
      },
      ctx
    );
  }

  if (shape === "polygon") {
    return runSelectPolygon(op, ctx);
  }

  throw new Error(`Unsupported setSelection shape '${shape}'`);
}

async function runModifySelection(op, ctx) {
  const mode = String(op.mode || "expand").toLowerCase();
  if (mode === "expand") {
    return runExpandSelection(op, ctx);
  }
  if (mode === "contract") {
    return runContractSelection(op, ctx);
  }
  if (mode === "feather") {
    return runFeatherSelection(op, ctx);
  }
  if (mode === "smooth") {
    return runSmoothSelection(op, ctx);
  }
  if (mode === "grow") {
    return runGrowSelection(op, ctx);
  }
  throw new Error(`Unsupported modifySelection mode '${mode}'`);
}

async function runCreateLayerMask(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const layerName = layer.name;
  await selectLayer(layer);

  const hasMask = await layerHasUserMask(layer);
  if (hasMask) {
    return {
      layer: serializeLayer(layer),
      refValue: buildLayerRefValue(layer),
      detail: `Layer mask already exists for '${layerName}'`
    };
  }

  if (typeof layer.createLayerMask === "function") {
    try {
      await layer.createLayerMask(Boolean(op.hideAll));
      return {
        layer: serializeLayer(layer),
        refValue: buildLayerRefValue(layer),
        detail: `Created layer mask for '${layerName}'`
      };
    } catch {
      // Fall through to optional batchPlay fallback.
    }
  }

  // Safe-mode default: avoid issuing raw make commands that can open modal
  // "Make command unavailable" popups in some Photoshop states.
  if (!op.forceBatchPlay) {
    return {
      layer: serializeLayer(layer),
      refValue: buildLayerRefValue(layer),
      detail: `Layer mask creation requires forceBatchPlay in this Photoshop state (skipped)`
    };
  }

  const fromSelection = Boolean(op.fromSelection);
  const modeValue = fromSelection ? "revealSelection" : op.hideAll ? "hideAll" : "revealAll";

  try {
    await runBatchPlay(
      [
        {
          _obj: "make",
          new: {
            _class: "channel"
          },
          at: {
            _ref: "channel",
            _enum: "channel",
            _value: "mask"
          },
          using: {
            _enum: "userMaskEnabled",
            _value: modeValue
          },
          _options: {
            dialogOptions: "dontDisplay"
          }
        }
      ],
      undefined,
      { op: "createLayerMask" }
    );
  } catch (error) {
    const detail = sanitizeError(error);
    if (/not currently available/i.test(detail.message)) {
      return {
        layer: serializeLayer(layer),
        refValue: buildLayerRefValue(layer),
        detail: `Layer mask make unavailable for '${layerName}' (skipped)`
      };
    }
    throw error;
  }

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Created layer mask for '${layerName}'`
  };
}

async function runDeleteLayerMask(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const layerName = layer.name;
  await selectLayer(layer);

  if (typeof layer.removeLayerMask === "function") {
    try {
      await layer.removeLayerMask(Boolean(op.apply));
      return {
        layer: serializeLayer(layer),
        refValue: buildLayerRefValue(layer),
        detail: `${op.apply ? "Applied" : "Deleted"} layer mask for '${layerName}'`
      };
    } catch {
      // Fall through to batchPlay fallback.
    }
  }

  const hasMask = await layerHasUserMask(layer);
  if (!hasMask) {
    return {
      layer: serializeLayer(layer),
      refValue: buildLayerRefValue(layer),
      detail: `No layer mask on '${layerName}' (skipped)`
    };
  }

  // Safe-mode default: avoid issuing raw delete channel commands that can surface
  // modal "Delete command unavailable" popups in some Photoshop states.
  if (!op.forceBatchPlay) {
    return {
      layer: serializeLayer(layer),
      refValue: buildLayerRefValue(layer),
      detail: `Layer mask operation requires forceBatchPlay in this Photoshop state (skipped)`
    };
  }

  try {
    await runBatchPlay(
      [
        {
          _obj: "delete",
          _target: [
            {
              _ref: "channel",
              _enum: "channel",
              _value: "mask"
            }
          ],
          apply: Boolean(op.apply),
          _options: {
            dialogOptions: "dontDisplay"
          }
        }
      ],
      undefined,
      { op: "deleteLayerMask" }
    );
  } catch (error) {
    const detail = sanitizeError(error);
    if (/not currently available/i.test(detail.message)) {
      return {
        layer: serializeLayer(layer),
        refValue: buildLayerRefValue(layer),
        detail: `Layer mask command unavailable for '${layerName}' (skipped)`
      };
    }
    throw error;
  }

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `${op.apply ? "Applied" : "Deleted"} layer mask for '${layerName}'`
  };
}

async function runApplyLayerMask(op, ctx) {
  return runDeleteLayerMask({
    ...op,
    apply: true
  }, ctx);
}

async function runCreateAdjustmentLayer(op, ctx) {
  const adjustment = String(op.adjustment || op.type || "levels").toLowerCase();
  const makeObj = adjustment === "curves" ? "curves" : adjustment === "huesaturation" || adjustment === "hue-sat" ? "hueSaturation" : "levels";

  await runBatchPlay(
    [
      {
        _obj: "make",
        _target: [
          {
            _ref: "adjustmentLayer"
          }
        ],
        using: {
          _obj: "adjustmentLayer",
          type: {
            _obj: makeObj
          }
        },
        _options: {
          dialogOptions: "dontDisplay"
        }
      }
    ],
    undefined,
    { op: "createAdjustmentLayer" }
  );

  const layer = activeDocumentOrThrow().activeLayers[0];
  if (layer && op.name) {
    layer.name = String(op.name);
  }

  return {
    layer: serializeLayer(layer),
    refValue: layer ? buildLayerRefValue(layer) : undefined,
    detail: `Created adjustment layer (${makeObj})`
  };
}

async function runApplyGaussianBlur(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const radius = toFiniteNumber(op.radius, undefined);
  if (!Number.isFinite(radius)) {
    throw new Error("applyGaussianBlur requires radius");
  }

  await selectLayer(layer);
  await layer.applyGaussianBlur(radius);

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Applied Gaussian Blur radius=${radius} to '${layer.name}'`
  };
}

async function runApplyUnsharpMask(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const amount = toFiniteNumber(op.amount, undefined);
  const radius = toFiniteNumber(op.radius, undefined);
  const threshold = toFiniteNumber(op.threshold, undefined);

  if (!Number.isFinite(amount) || !Number.isFinite(radius) || !Number.isFinite(threshold)) {
    throw new Error("applyUnsharpMask requires amount, radius, threshold");
  }

  await selectLayer(layer);
  await layer.applyUnSharpMask(amount, radius, threshold);

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Applied Unsharp Mask to '${layer.name}'`
  };
}

async function runApplySharpen(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  await selectLayer(layer);
  await layer.applySharpen();

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Applied Sharpen to '${layer.name}'`
  };
}

async function runApplyBlur(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  await selectLayer(layer);
  await layer.applyBlur();

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Applied Blur to '${layer.name}'`
  };
}

async function runApplyFilter(op, ctx) {
  const filter = String(op.filter || op.kind || "").toLowerCase();
  if (!filter) {
    throw new Error("applyFilter requires filter");
  }

  if (filter === "gaussianblur" || filter === "gaussian") {
    return runApplyGaussianBlur(op, ctx);
  }
  if (filter === "unsharpmask" || filter === "unsharp") {
    return runApplyUnsharpMask(op, ctx);
  }
  if (filter === "sharpen") {
    return runApplySharpen(op, ctx);
  }
  if (filter === "blur") {
    return runApplyBlur(op, ctx);
  }

  throw new Error(`Unsupported applyFilter filter '${filter}'`);
}

async function runCreateTextLayer(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const text = op.text !== undefined ? normalizeTextContents(op.text) : op.contents !== undefined ? normalizeTextContents(op.contents) : undefined;
  const requestedFont = String(op.fontName || op.font || "").trim();
  if (text === undefined) {
    throw new Error("createTextLayer requires text or contents");
  }

  const createTextLayerCore = async () => {
    if (typeof doc.createTextLayer === "function") {
      const options = {
        contents: text
      };

      if (op.name) options.name = String(op.name);
      if (Number.isFinite(Number(op.fontSize))) options.fontSize = Number(op.fontSize);
      if (requestedFont) options.font = resolveInstalledFontName(requestedFont);
      if (op.position && Number.isFinite(Number(op.position.x)) && Number.isFinite(Number(op.position.y))) {
        options.position = {
          x: Number(op.position.x),
          y: Number(op.position.y)
        };
      }

      return doc.createTextLayer(options);
    }

    return doc.createLayer(resolveLayerKind("text"), {
      name: op.name,
      contents: text
    });
  };

  let layer;
  let usedSafeFallback = false;
  try {
    layer = await createTextLayerCore();
  } catch (primaryError) {
    // Fallback retained for Photoshop states where text creation can be unstable
    // with the currently active layer. Keep this path exceptional so normal runs
    // preserve top-of-stack insertion semantics.
    const baseLayer = pickSafeInsertBaseLayer(doc);
    if (!baseLayer) {
      throw primaryError;
    }

    try {
      await selectLayer(baseLayer);
      layer = await createTextLayerCore();
      usedSafeFallback = true;
      pushEvent("warn", "createTextLayer used safe insertion fallback");
    } catch {
      throw primaryError;
    }
  }

  if (op.name && layer) {
    layer.name = String(op.name);
  }
  if (requestedFont && layer?.textItem) {
    const resolvedFont = resolveInstalledFontName(requestedFont);
    try {
      if (layer.textItem.characterStyle) {
        layer.textItem.characterStyle.font = resolvedFont;
      }
      if ("font" in layer.textItem) {
        layer.textItem.font = resolvedFont;
      }
    } catch {
      // Font assignment can fail on unavailable family/style combinations.
    }
  }

  const maxWidth = toFiniteNumber(op.maxWidth, undefined);
  const maxHeight = toFiniteNumber(op.maxHeight, undefined);
  if (layer?.textItem && (Number.isFinite(maxWidth) || Number.isFinite(maxHeight))) {
    await fitTextLayerBounds(layer, {
      maxWidth,
      maxHeight,
      minFontSize: toFiniteNumber(op.minFontSize, 8)
    });
  }

  if (layer?.textItem && Array.isArray(op.avoidOverlapWith) && op.avoidOverlapWith.length > 0) {
    await avoidLayerOverlaps(layer, op.avoidOverlapWith, ctx.refs, {
      gap: toFiniteNumber(op.overlapGap, 8)
    });
  }

  if (usedSafeFallback && layer && typeof layer.bringToFront === "function") {
    try {
      layer.bringToFront();
    } catch {
      // Non-fatal visibility safeguard.
    }
  }

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Created text layer '${layer.name}'`
  };
}

async function runSetText(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  if (!layer.textItem) {
    throw new Error(`Layer '${layer.name}' is not a text layer`);
  }
  if (op.text === undefined && op.contents === undefined) {
    throw new Error("setText requires text or contents");
  }

  layer.textItem.contents = normalizeTextContents(op.text !== undefined ? op.text : op.contents);

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Updated text contents for '${layer.name}'`
  };
}

async function runSetTextStyle(op, ctx) {
  const layer = requireLayerTarget(op, ctx.refs);
  const textItem = layer.textItem;
  if (!textItem) {
    throw new Error(`Layer '${layer.name}' is not a text layer`);
  }

  let applied = 0;

  if (op.text !== undefined || op.contents !== undefined) {
    textItem.contents = normalizeTextContents(op.text !== undefined ? op.text : op.contents);
    applied += 1;
  }

  if (Number.isFinite(Number(op.fontSize)) && textItem.characterStyle) {
    textItem.characterStyle.size = Number(op.fontSize);
    applied += 1;
  }

  const requestedFont = String(op.fontName || op.font || "").trim();
  if (requestedFont) {
    const resolvedFont = resolveInstalledFontName(requestedFont);
    const candidates = [resolvedFont, requestedFont].filter((value, index, arr) => value && arr.indexOf(value) === index);

    let appliedFontName = "";
    let lastFontError = null;

    for (const candidate of candidates) {
      try {
        if (textItem.characterStyle) {
          textItem.characterStyle.font = candidate;
        }
        if ("font" in textItem) {
          textItem.font = candidate;
        }

        const observed =
          (typeof textItem.characterStyle?.font === "string" && textItem.characterStyle.font) ||
          (typeof textItem.font === "string" && textItem.font) ||
          "";

        if (fontLooksLike(observed, requestedFont) || fontLooksLike(observed, candidate)) {
          appliedFontName = observed || candidate;
          break;
        }
      } catch (error) {
        lastFontError = error;
      }
    }

    if (!appliedFontName) {
      const observed =
        (typeof textItem.characterStyle?.font === "string" && textItem.characterStyle.font) ||
        (typeof textItem.font === "string" && textItem.font) ||
        "";
      if (lastFontError) {
        throw new Error(`Failed to set font '${requestedFont}': ${sanitizeError(lastFontError).message}`);
      }
      throw new Error(
        `Requested font '${requestedFont}' was not applied${observed ? ` (current='${observed}')` : ""}. Use an installed PostScript or family/style name.`
      );
    }

    applied += 1;
  }

  if (op.position && Number.isFinite(Number(op.position.x)) && Number.isFinite(Number(op.position.y)) && "position" in textItem) {
    textItem.position = {
      x: Number(op.position.x),
      y: Number(op.position.y)
    };
    applied += 1;
  }

  const maxWidth = toFiniteNumber(op.maxWidth, undefined);
  const maxHeight = toFiniteNumber(op.maxHeight, undefined);
  if (Number.isFinite(maxWidth) || Number.isFinite(maxHeight)) {
    const fitResult = await fitTextLayerBounds(layer, {
      maxWidth,
      maxHeight,
      minFontSize: toFiniteNumber(op.minFontSize, 8)
    });
    if (fitResult.adjusted) {
      applied += 1;
    }
  }

  if (Array.isArray(op.avoidOverlapWith) && op.avoidOverlapWith.length > 0) {
    const moved = await avoidLayerOverlaps(layer, op.avoidOverlapWith, ctx.refs, {
      gap: toFiniteNumber(op.overlapGap, 8)
    });
    if (moved > 0) {
      applied += 1;
    }
  }

  if (applied === 0) {
    throw new Error("setTextStyle did not find supported style fields (text/fontSize/fontName/font/position/maxWidth/maxHeight/avoidOverlapWith)");
  }

  return {
    layer: serializeLayer(layer),
    refValue: buildLayerRefValue(layer),
    detail: `Updated text style on '${layer.name}' (${applied} fields)`
  };
}

function parseHexColor(value) {
  if (typeof value !== "string") {
    return null;
  }
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }

  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function normalizeRgbColor(rawColor) {
  if (rawColor && typeof rawColor === "object") {
    const r = toFiniteNumber(rawColor.r ?? rawColor.red, undefined);
    const g = toFiniteNumber(rawColor.g ?? rawColor.green, undefined);
    const b = toFiniteNumber(rawColor.b ?? rawColor.blue, undefined);

    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return {
        r,
        g,
        b
      };
    }
  }

  if (typeof rawColor === "string") {
    const parsed = parseHexColor(rawColor);
    if (parsed) {
      return parsed;
    }
  }

  return {
    r: 255,
    g: 255,
    b: 255
  };
}

function unitPx(value) {
  return {
    _unit: "pixelsUnit",
    _value: Number(value)
  };
}

async function runCreateShapeLayer(op, ctx) {
  const bounds = op.bounds || {
    left: op.x,
    top: op.y,
    right: Number(op.x || 0) + Number(op.width || 0),
    bottom: Number(op.y || 0) + Number(op.height || 0)
  };

  if (!Number.isFinite(Number(bounds.left)) || !Number.isFinite(Number(bounds.top)) || !Number.isFinite(Number(bounds.right)) || !Number.isFinite(Number(bounds.bottom))) {
    throw new Error("createShapeLayer requires bounds or x/y/width/height");
  }

  const color = normalizeRgbColor(op.fill || op.color || "#FFFFFF");
  const shapeType = String(op.shape || op.shapeType || "rectangle").toLowerCase();
  const shapeObj = shapeType === "ellipse" || shapeType === "circle" ? "ellipse" : "rectangle";

  await runBatchPlay(
    [
      {
        _obj: "make",
        _target: [
          {
            _ref: "contentLayer"
          }
        ],
        using: {
          _obj: "contentLayer",
          type: {
            _obj: "solidColorLayer",
            color: {
              _obj: "RGBColor",
              red: color.r,
              grain: color.g,
              blue: color.b
            }
          },
          shape: {
            _obj: shapeObj,
            top: unitPx(bounds.top),
            left: unitPx(bounds.left),
            bottom: unitPx(bounds.bottom),
            right: unitPx(bounds.right)
          }
        },
        _options: {
          dialogOptions: "dontDisplay"
        }
      }
    ],
    undefined,
    { op: "createShapeLayer" }
  );

  const layer = activeDocumentOrThrow().activeLayers[0];
  if (op.name && layer) {
    layer.name = String(op.name);
  }

  return {
    layer: serializeLayer(layer),
    refValue: layer ? buildLayerRefValue(layer) : undefined,
    detail: `Created ${shapeObj} shape layer`
  };
}

async function runExport(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const format = normalizeSaveMethod(resolveSaveFormat(op));
  const output = op.output ? String(op.output) : undefined;
  if (!output) {
    throw new Error("export requires output path");
  }

  if (op.target !== undefined) {
    const layer = requireLayerTarget(op, ctx.refs, { doc });
    await selectLayer(layer);

    const parts = splitOutputPath(output);
    if (!parts.folder || parts.folder === ".") {
      throw new Error("Layer-targeted export requires an output path with an explicit folder");
    }
    const folderEntry = await getFolderEntryForPath(parts.folder, { create: true });

    try {
      await runBatchPlay(
        [
          {
            _obj: "exportSelectionAsFileTypePressed",
            _target: {
              _ref: "layer",
              _enum: "ordinal",
              _value: "targetEnum"
            },
            fileType: format,
            quality: Number.isFinite(Number(op.quality)) ? Number(op.quality) : 32,
            metadata: op.metadata !== undefined ? Number(op.metadata) : 0,
            destFolder: folderEntry.nativePath,
            sRGB: op.sRGB !== undefined ? Boolean(op.sRGB) : true,
            openWindow: false,
            _options: {
              dialogOptions: "dontDisplay"
            }
          }
        ],
        undefined,
        { op: "export(layer)" }
      );
    } catch (error) {
      if (isEmptySelectionExportError(error)) {
        return {
          output,
          format,
          layer: serializeLayer(layer),
          refValue: buildLayerRefValue(layer),
          skipped: true,
          detail: `Layer '${layer.name}' has no exportable pixel selection; skipped export`
        };
      }
      throw error;
    }

    return {
      output,
      format,
      layer: serializeLayer(layer),
      refValue: buildLayerRefValue(layer),
      detail: `Exported selected layer '${layer.name}' to folder '${folderEntry.nativePath}' (filename controlled by Photoshop)`
    };
  }

  const fileEntry = await getFileEntryForSave(output);

  if (!doc.saveAs || typeof doc.saveAs[format] !== "function") {
    throw new Error(`export format '${format}' is not supported via saveAs API`);
  }

  const saveOptions = op.options && typeof op.options === "object" ? op.options : {};
  if (format === "jpg") {
    const quality = toFiniteNumber(op.quality, undefined);
    if (quality !== undefined && saveOptions.quality === undefined) {
      saveOptions.quality = Math.max(0, Math.min(12, quality > 12 ? Math.round(quality / 8.3333) : quality));
    }
  }

  await doc.saveAs[format](fileEntry, saveOptions, true);

  return {
    output: fileEntry.nativePath || output,
    format,
    detail: `Exported document as ${format.toUpperCase()}`
  };
}

async function runExportDocument(op, ctx) {
  return runExport(
    {
      ...op,
      target: undefined
    },
    ctx
  );
}

async function runExportLayer(op, ctx) {
  if (!op.target) {
    throw new Error("exportLayer requires target");
  }
  return runExport(op, ctx);
}

async function runExportLayersByName(op, ctx) {
  const doc = findDocument(op.docRef || "active", ctx.refs) || activeDocumentOrThrow();
  const match = String(op.match || "");
  if (!match) {
    throw new Error("exportLayersByName requires match");
  }
  const outputDir = String(op.outputDir || op.output || "");
  if (!outputDir) {
    throw new Error("exportLayersByName requires outputDir");
  }

  const regex = new RegExp(match, "i");
  const layers = flattenLayers(doc.layers || []).filter((layer) => regex.test(layer.name));
  const format = op.format || "png";
  const results = [];

  for (const layer of layers) {
    const outputPath = `${outputDir}/${layer.name}.${format}`;
    const exported = await runExport(
      {
        ...op,
        target: buildLayerRefValue(layer),
        output: outputPath,
        format
      },
      ctx
    );
    results.push({
      layer: serializeLayer(layer),
      output: exported.output
    });
  }

  return {
    count: results.length,
    exports: results,
    detail: `Exported ${results.length} layer(s) by name`
  };
}

async function runBatchPlayOp(op, ctx) {
  const commands = Array.isArray(op.commands)
    ? op.commands
    : op.command
      ? [op.command]
      : op.descriptor
        ? [op.descriptor]
        : null;

  if (!commands || commands.length === 0) {
    throw new Error("batchPlay op requires commands[] or command/descriptor");
  }

  const noopOnly = commands.every(
    (command) => command && typeof command === "object" && String(command._obj || "").toLowerCase() === "noop"
  );
  if (noopOnly) {
    return {
      descriptorCount: commands.length,
      descriptors: [],
      skipped: true,
      detail: `Skipped ${commands.length} noop batchPlay descriptor(s)`
    };
  }

  let descriptors;
  try {
    descriptors = await runBatchPlay(commands, op.options || {}, {
      op: `batchPlay#${ctx.index}`
    });
  } catch (error) {
    const detail = sanitizeError(error);
    if (op.allowUnavailable === true && /not currently available/i.test(detail.message)) {
      return {
        descriptorCount: commands.length,
        descriptors: [],
        skipped: true,
        detail: "batchPlay command unavailable in current Photoshop state (skipped)"
      };
    }
    throw error;
  }

  return {
    descriptorCount: commands.length,
    descriptors,
    detail: `Executed batchPlay with ${commands.length} descriptor(s)`
  };
}

function registerOperations() {
  registerOp(["createDocument", "doc.create", "document.create", "newDocument"], runCreateDocument);
  registerOp(["openDocument", "doc.open", "document.open"], runOpenDocumentOp);
  registerOp(["duplicateDocument", "doc.duplicate", "document.duplicate"], runDuplicateDocument);
  registerOp(["saveDocument", "doc.save", "document.save"], runSaveDocument);
  registerOp(["saveDocumentAs", "doc.saveAs", "document.saveAs"], runSaveDocumentAs);
  registerOp(["closeDocument", "doc.close", "document.close"], runCloseDocument);
  registerOp(["resizeImage", "document.resizeImage"], runResizeImage);
  registerOp(["resizeCanvas", "document.resizeCanvas"], runResizeCanvas);
  registerOp(["cropDocument", "document.crop"], runCropDocument);
  registerOp(["flattenDocument", "flattenImage", "document.flatten"], runFlattenDocument);
  registerOp(["mergeVisible", "mergeVisibleLayers", "document.mergeVisibleLayers"], runMergeVisible);
  registerOp(["trimDocument", "document.trim"], runTrimDocument);
  registerOp(["rotateDocument", "document.rotate"], runRotateDocument);

  registerOp(["createLayer", "layer.create"], runCreateLayer);
  registerOp(["createPixelLayer", "layer.createPixel"], runCreatePixelLayer);
  registerOp(["createGroup", "createLayerGroup", "layer.createGroup"], runCreateGroup);
  registerOp(["groupLayers", "layer.group"], runGroupLayers);
  registerOp(["ungroupLayer", "layer.ungroup"], runUngroupLayer);
  registerOp(["deleteLayer", "layer.delete"], runDeleteLayer);
  registerOp(["renameLayer", "layer.rename"], runRenameLayer);
  registerOp(["duplicateLayer", "layer.duplicate"], runDuplicateLayer);
  registerOp(["selectLayer", "layer.select"], runSelectLayer);
  registerOp(["selectLayers", "layer.selectMany"], runSelectLayers);
  registerOp(["moveLayer", "layer.move", "reorderLayer", "layer.reorder"], runMoveLayer);
  registerOp(["setLayerVisibility", "layer.visibility"], runSetLayerVisibility);
  registerOp(["showLayer", "layer.show"], runShowLayer);
  registerOp(["hideLayer", "layer.hide"], runHideLayer);
  registerOp(["setLayerOpacity", "layer.opacity"], runSetLayerOpacity);
  registerOp(["setBlendMode", "layer.blendMode"], runSetBlendMode);
  registerOp(["setLayerProps", "layer.setProps"], runSetLayerProps);
  registerOp(["bringLayerToFront", "layer.bringToFront"], runBringLayerToFront);
  registerOp(["sendLayerToBack", "layer.sendToBack"], runSendLayerToBack);
  registerOp(["mergeLayer", "mergeLayers", "layer.merge"], runMergeLayer);
  registerOp(["rasterizeLayer", "layer.rasterize"], runRasterizeLayer);
  registerOp(["linkLayers", "layer.link"], runLinkLayers);
  registerOp(["unlinkLayer", "layer.unlink"], runUnlinkLayer);

  registerOp(["transformLayer", "layer.transform"], runTransformLayer);
  registerOp(["alignLayers", "layer.align"], runAlignLayers);
  registerOp(["distributeLayers", "layer.distribute"], runDistributeLayers);
  registerOp(["translateLayer", "layer.translate"], runTranslateLayer);
  registerOp(["scaleLayer", "layer.scale"], runScaleLayer);
  registerOp(["rotateLayer", "layer.rotate"], runRotateLayer);
  registerOp(["flipLayer", "layer.flip"], runFlipLayer);
  registerOp(["skewLayer", "layer.skew"], runSkewLayer);

  registerOp(["placeAsset", "asset.place"], runPlaceAsset);
  registerOp(["convertToSmartObject", "smartObject.convert"], runConvertToSmartObject);
  registerOp(["replaceSmartObject", "smartObject.replace"], runReplaceSmartObject);
  registerOp(["relinkSmartObject", "smartObject.relink"], runRelinkSmartObject);
  registerOp(["editSmartObject", "smartObject.edit"], runEditSmartObject);

  registerOp(["selectAll", "selection.selectAll"], runSelectAll);
  registerOp(["deselect", "selection.deselect"], runDeselect);
  registerOp(["inverseSelection", "invertSelection", "selection.inverse"], runInverseSelection);
  registerOp(["featherSelection", "selection.feather"], runFeatherSelection);
  registerOp(["expandSelection", "selection.expand"], runExpandSelection);
  registerOp(["contractSelection", "selection.contract"], runContractSelection);
  registerOp(["growSelection", "selection.grow"], runGrowSelection);
  registerOp(["smoothSelection", "selection.smooth"], runSmoothSelection);
  registerOp(["selectRectangle", "selection.selectRectangle"], runSelectRectangle);
  registerOp(["selectEllipse", "selection.selectEllipse"], runSelectEllipse);
  registerOp(["selectPolygon", "selection.selectPolygon"], runSelectPolygon);
  registerOp(["selectLayerPixels", "selection.loadLayerPixels"], runSelectLayerPixels);
  registerOp(["setSelection", "selection.set"], runSetSelection);
  registerOp(["modifySelection", "selection.modify"], runModifySelection);
  registerOp(["createLayerMask", "layerMask.create"], runCreateLayerMask);
  registerOp(["addLayerMask", "layerMask.add"], runCreateLayerMask);
  registerOp(["deleteLayerMask", "layerMask.delete"], runDeleteLayerMask);
  registerOp(["removeLayerMask", "layerMask.remove"], runDeleteLayerMask);
  registerOp(["applyLayerMask", "layerMask.apply"], runApplyLayerMask);

  registerOp(["createAdjustmentLayer", "adjustment.create"], runCreateAdjustmentLayer);
  registerOp(["applyFilter", "filter.apply"], runApplyFilter);
  registerOp(["applyGaussianBlur", "filter.gaussianBlur"], runApplyGaussianBlur);
  registerOp(["applyUnsharpMask", "filter.unsharpMask"], runApplyUnsharpMask);
  registerOp(["applySharpen", "filter.sharpen"], runApplySharpen);
  registerOp(["applyBlur", "filter.blur"], runApplyBlur);

  registerOp(["createTextLayer", "text.create"], runCreateTextLayer);
  registerOp(["setText", "text.set"], runSetText);
  registerOp(["setTextStyle", "text.style"], runSetTextStyle);
  registerOp(["createShapeLayer", "shape.create"], runCreateShapeLayer);

  registerOp(["export", "document.export", "render"], runExport);
  registerOp(["exportDocument", "document.exportDocument"], runExportDocument);
  registerOp(["exportLayer", "document.exportLayer"], runExportLayer);
  registerOp(["exportLayersByName", "document.exportLayersByName"], runExportLayersByName);
  registerOp(["batchPlay", "action.batchPlay"], runBatchPlayOp);
}

registerOperations();

function readLayersSafely() {
  try {
    const doc = activeDocumentOrThrow();
    return flattenLayers(doc.layers || []).map(serializeLayer);
  } catch (error) {
    const message = error?.message || String(error);
    pushEvent("warn", `layer read fallback: ${message}`);
    return [];
  }
}

function normalizeOnErrorPolicy(rawValue, fallback = DEFAULT_ON_ERROR) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return fallback;
  }

  const normalized = String(rawValue).trim().toLowerCase();
  return normalized === "continue" ? "continue" : "abort";
}

function extractRequestedRefName(op) {
  for (const key of REF_ASSIGNMENT_FIELDS) {
    const candidate = normalizeRefName(op?.[key]);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function inferRefValue(opName, op, opResult, fallbackKey) {
  if (opResult?.refValue !== undefined) {
    return cloneSerializable(opResult.refValue);
  }

  if (opResult?.layer && isLayerLike(opResult.layer)) {
    return {
      kind: "layer",
      layerId: String(opResult.layer.id || opResult.layer.layerId),
      layerName: opResult.layer.name || opResult.layer.layerName,
      id: String(opResult.layer.id || opResult.layer.layerId),
      name: opResult.layer.name || opResult.layer.layerName
    };
  }

  if (opResult?.document && opResult.document.id !== undefined) {
    return {
      kind: "document",
      docId: String(opResult.document.id),
      title: opResult.document.title,
      ref: "active"
    };
  }

  if (opName === "createLayer" || opName === "createPixelLayer" || opName === "createGroup" || opName === "groupLayers" || opName === "duplicateLayer") {
    const inferredName = typeof op.name === "string" && op.name ? op.name : `${opName}:${fallbackKey}`;
    return {
      kind: "layer",
      layerId: `dry-${fallbackKey}`,
      layerName: inferredName,
      id: `dry-${fallbackKey}`,
      name: inferredName
    };
  }

  return cloneSerializable(opResult);
}

async function createCheckpoint(docRef, label) {
  const doc = findDocument(docRef || "active", {});
  if (!doc) {
    throw new Error("createCheckpoint: target document not found");
  }

  const id = `cp-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const item = {
    id,
    createdAt: new Date().toISOString(),
    label: typeof label === "string" ? label : undefined,
    docId: String(doc.id),
    docTitle: doc.title,
    strategy: "none",
    restoreSupported: false,
    behavior: "best-effort"
  };

  try {
    const historyState = doc.activeHistoryState;
    if (historyState?.id !== undefined) {
      item.historyStateId = Number(historyState.id);
      item.historyStateName = historyState.name;
      item.strategy = "historyStatePointer";
      item.restoreSupported = true;
    }
  } catch (error) {
    item.historyStateError = sanitizeError(error);
  }

  const snapshotName = `psagent:${id}`;

  try {
    await runBatchPlay(
      [
        {
          _obj: "make",
          _target: [
            {
              _ref: "snapshotClass"
            }
          ],
          from: {
            _ref: "historyState",
            _property: "currentHistoryState"
          },
          name: snapshotName,
          using: {
            _enum: "historyState",
            _value: "fullDocument"
          },
          _isCommand: true,
          _options: {
            dialogOptions: "dontDisplay"
          }
        }
      ],
      undefined,
      { op: "checkpoint.create" }
    );

    item.snapshotName = snapshotName;
    item.strategy = "historySnapshot";
    item.restoreSupported = true;
    item.detail = `Snapshot '${snapshotName}' created`;
  } catch (error) {
    item.snapshotError = sanitizeError(error);
    if (item.restoreSupported) {
      item.detail = `Snapshot unavailable; will fallback to history state pointer`;
    } else {
      item.detail = `Snapshot unavailable and history pointer unavailable; rollback may be impossible`;
    }
  }

  bridgeState.checkpoints.push(item);
  pushEvent("info", `checkpoint.create id=${id} strategy=${item.strategy}`);
  return item;
}

function listCheckpoints() {
  return bridgeState.checkpoints.slice();
}

async function restoreCheckpoint(docRef, checkpointId) {
  const checkpoint = bridgeState.checkpoints.find((cp) => cp.id === checkpointId);
  if (!checkpoint) {
    throw new Error(`checkpoint not found: ${checkpointId}`);
  }

  const doc = findDocument(docRef || "active", {});
  if (!doc) {
    throw new Error(`restoreCheckpoint: target document not found for ${checkpointId}`);
  }

  let restored = false;
  let strategy = "none";
  let detail = "";

  if (checkpoint.snapshotName) {
    try {
      const states = Array.from(doc.historyStates || []);
      const snapshot = states.find((state) => state.snapshot && state.name === checkpoint.snapshotName);
      if (snapshot) {
        doc.activeHistoryState = snapshot;
        restored = true;
        strategy = "historySnapshot";
        detail = `Restored snapshot '${checkpoint.snapshotName}' via DOM`;
      } else {
        await runBatchPlay(
          [
            {
              _obj: "select",
              _target: [
                {
                  _ref: "snapshotClass",
                  _name: checkpoint.snapshotName
                }
              ],
              _isCommand: true,
              _options: {
                dialogOptions: "dontDisplay"
              }
            }
          ],
          undefined,
          { op: "checkpoint.restore(snapshot)" }
        );
        restored = true;
        strategy = "historySnapshot";
        detail = `Restored snapshot '${checkpoint.snapshotName}' via batchPlay`;
      }
    } catch (error) {
      detail = `Snapshot restore failed: ${error?.message || String(error)}`;
    }
  }

  if (!restored && checkpoint.historyStateId !== undefined) {
    try {
      const states = Array.from(doc.historyStates || []);
      const state = states.find((candidate) => Number(candidate.id) === Number(checkpoint.historyStateId));
      if (state) {
        doc.activeHistoryState = state;
        restored = true;
        strategy = "historyStatePointer";
        detail = `Restored history state id=${checkpoint.historyStateId}`;
      } else {
        detail = `${detail ? `${detail}; ` : ""}history state id=${checkpoint.historyStateId} no longer available`;
      }
    } catch (error) {
      detail = `${detail ? `${detail}; ` : ""}history pointer restore failed: ${error?.message || String(error)}`;
    }
  }

  if (!detail) {
    detail = restored ? "Checkpoint restored" : "Checkpoint could not be restored";
  }

  pushEvent("info", `checkpoint.restore id=${checkpointId} restored=${String(restored)} strategy=${strategy}`);

  return {
    restored,
    strategy,
    supported: Boolean(checkpoint.restoreSupported),
    behavior: checkpoint.behavior || "best-effort",
    detail
  };
}

function tailEvents(limit) {
  const n = Math.max(1, Number(limit) || 20);
  return bridgeState.events.slice(-n);
}

function validateOperationBasic(op) {
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    throw new Error("Each op must be an object");
  }
  if (typeof op.op !== "string" || op.op.trim() === "") {
    throw new Error("Each op requires string field 'op'");
  }
  if (op.onError !== undefined) {
    const normalized = String(op.onError).trim().toLowerCase();
    if (normalized !== "abort" && normalized !== "continue") {
      throw new Error(`Invalid onError policy '${op.onError}'. Use 'abort' or 'continue'.`);
    }
  }
}

function hasMeaningfulValue(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function opHasAnyField(op, fields) {
  return fields.some((field) => hasMeaningfulValue(op?.[field]));
}

function validateOperationEnvelopeShape(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Operation payload must be an object");
  }

  if (typeof payload.transactionId !== "string" || payload.transactionId.trim() === "") {
    throw new Error("Operation payload requires non-empty string 'transactionId'");
  }

  if (!payload.doc || typeof payload.doc !== "object" || Array.isArray(payload.doc)) {
    throw new Error("Operation payload requires object field 'doc'");
  }

  if (!Array.isArray(payload.ops) || payload.ops.length === 0) {
    throw new Error("Operation payload requires non-empty array field 'ops'");
  }

  const safety = payload.safety;
  if (safety !== undefined && (typeof safety !== "object" || Array.isArray(safety))) {
    throw new Error("Operation payload field 'safety' must be an object");
  }

  if (safety && safety.onError !== undefined) {
    const normalized = String(safety.onError).trim().toLowerCase();
    if (normalized !== "abort" && normalized !== "continue") {
      throw new Error(`Invalid safety.onError policy '${safety.onError}'. Use 'abort' or 'continue'.`);
    }
  }

  for (const op of payload.ops) {
    validateOperationBasic(op);
  }
}

function validateResolvedOperation(opName, op, refs) {
  if (OP_REQUIRES_ACTIVE_DOCUMENT.has(opName) && !app.activeDocument) {
    throw new Error(`Op '${opName}' requires an active Photoshop document`);
  }

  if (OP_REQUIRES_LAYER_TARGET.has(opName)) {
    try {
      const layer = findLayer(op?.target, refs);
      if (!layer) {
        throw new Error("target layer was not found");
      }
    } catch (error) {
      throw new Error(`Op '${opName}' target validation failed: ${getErrorMessage(error)}`);
    }
  }

  if (opName === "renameLayer" && !opHasAnyField(op, ["newName", "name"])) {
    throw new Error("renameLayer requires newName or name");
  }

  if ((opName === "createTextLayer" || opName === "setText") && !opHasAnyField(op, ["text", "contents"])) {
    throw new Error(`${opName} requires text or contents`);
  }

  if (
    opName === "setTextStyle" &&
    !opHasAnyField(op, ["text", "contents", "fontSize", "fontName", "font", "position", "maxWidth", "maxHeight", "avoidOverlapWith"])
  ) {
    throw new Error(
      "setTextStyle requires at least one supported field: text/contents/fontSize/fontName/font/position/maxWidth/maxHeight/avoidOverlapWith"
    );
  }

  if (opName === "createShapeLayer") {
    const hasBounds = op?.bounds && typeof op.bounds === "object";
    if (!hasBounds && !opHasAnyField(op, ["x", "y", "width", "height"])) {
      throw new Error("createShapeLayer requires bounds or x/y/width/height");
    }
  }

  if ((opName === "placeAsset" || opName === "replaceSmartObject" || opName === "relinkSmartObject" || opName === "openDocument") &&
      !opHasAnyField(op, ["input", "path", "source"])) {
    throw new Error(`${opName} requires input/path/source`);
  }

  if (opName === "batchPlay" && !opHasAnyField(op, ["commands", "command", "descriptor"])) {
    throw new Error("batchPlay requires commands[] or command/descriptor");
  }

  if ((opName === "export" || opName === "exportDocument" || opName === "exportLayer") && !opHasAnyField(op, ["output"])) {
    throw new Error(`${opName} requires output`);
  }

  if (opName === "exportLayersByName") {
    if (!opHasAnyField(op, ["match"])) {
      throw new Error("exportLayersByName requires match");
    }
    if (!opHasAnyField(op, ["outputDir", "output"])) {
      throw new Error("exportLayersByName requires outputDir or output");
    }
  }

  if (opName === "applyFilter" && !opHasAnyField(op, ["filter", "kind"])) {
    throw new Error("applyFilter requires filter");
  }

  if ((opName === "selectRectangle" || opName === "selectEllipse") && (!op?.bounds || typeof op.bounds !== "object")) {
    throw new Error(`${opName} requires bounds`);
  }

  if (opName === "selectPolygon" && (!Array.isArray(op?.points) || op.points.length < 3)) {
    throw new Error("selectPolygon requires points[3+] array");
  }
}

async function executeOperation(opName, resolvedOp, context) {
  const handler = OP_HANDLER_TABLE.get(opName);
  if (!handler) {
    throw new Error(`No handler for op '${opName}'`);
  }

  const result = await handler(resolvedOp, context);
  if (result === undefined) {
    return {
      detail: `Executed '${opName}'`
    };
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`Op '${opName}' returned invalid result; expected object`);
  }
  return result;
}

function buildRollbackSummary(requested) {
  return {
    requested,
    supported: true,
    strategy: "historySnapshot+historyPointer",
    behavior: "best-effort",
    checkpointId: undefined,
    attempted: false,
    restored: false,
    detail: requested ? "rollbackOnError enabled" : "rollbackOnError disabled"
  };
}

async function runOpsCore(payload, controls) {
  const tx = payload?.transactionId || "tx-unknown";
  const ops = Array.isArray(payload?.ops) ? payload.ops : [];
  const dryRun = Boolean(payload?.safety?.dryRun);
  const rollbackRequested = Boolean(payload?.safety?.rollbackOnError);
  const checkpointRequested = Boolean(payload?.safety?.checkpoint);
  const defaultOnError = normalizeOnErrorPolicy(
    payload?.safety?.onError ?? (payload?.safety?.continueOnError ? "continue" : undefined),
    DEFAULT_ON_ERROR
  );

  if (ops.length === 0) {
    throw new Error("No ops provided");
  }

  for (const op of ops) {
    validateOperationBasic(op);
  }

  const refs = {};
  const opResults = [];

  let applied = 0;
  let failed = 0;
  let aborted = false;
  let abortReason = "";
  let checkpoint = null;
  const rollback = buildRollbackSummary(rollbackRequested);

  if (!dryRun && (rollbackRequested || checkpointRequested)) {
    try {
      checkpoint = await createCheckpoint("active", `tx:${tx}`);
      rollback.checkpointId = checkpoint.id;
      rollback.supported = Boolean(checkpoint.restoreSupported);
      rollback.strategy = checkpoint.strategy || rollback.strategy;
      rollback.detail = checkpoint.detail || rollback.detail;
    } catch (error) {
      const detail = sanitizeError(error);
      rollback.supported = false;
      rollback.detail = `checkpoint.create failed: ${detail.message}`;
      pushEvent("warn", `checkpoint create failed tx=${tx} error=${detail.message}`);
    }
  }

  for (let index = 0; index < ops.length; index += 1) {
    const originalOp = ops[index];
    const onError = normalizeOnErrorPolicy(originalOp.onError, defaultOnError);
    const startedAt = Date.now();

    try {
      const resolvedOp = resolveOperationRefs(originalOp, refs);
      const opName = resolveOperationName(resolvedOp.op);
      resolvedOp.op = opName;
      validateResolvedOperation(opName, resolvedOp, refs);

      if (dryRun) {
        const requestedRef = extractRequestedRefName(resolvedOp);
        if (requestedRef) {
          refs[requestedRef] = inferRefValue(opName, resolvedOp, { detail: "dryRun placeholder" }, `dry-${index}`);
        }

        opResults.push({
          index,
          op: originalOp.op,
          canonicalOp: opName,
          onError,
          status: "validated",
          durationMs: Date.now() - startedAt
        });

        applied += 1;
        continue;
      }

      const result = await executeOperation(opName, resolvedOp, {
        refs,
        index,
        tx
      });

      const cleanResult = cloneSerializable(result);
      if (cleanResult && typeof cleanResult === "object") {
        delete cleanResult.refValue;
      }

      const requestedRef = extractRequestedRefName(resolvedOp);
      const inferredRef = inferRefValue(opName, resolvedOp, result, `op${index}`);

      if (inferredRef !== undefined) {
        refs.last = cloneSerializable(inferredRef);
        if (inferredRef?.kind === "layer") {
          refs.lastLayer = cloneSerializable(inferredRef);
        }
        if (inferredRef?.kind === "document") {
          refs.lastDocument = cloneSerializable(inferredRef);
        }
      }

      if (requestedRef && inferredRef !== undefined) {
        refs[requestedRef] = cloneSerializable(inferredRef);
      }

      opResults.push({
        index,
        op: originalOp.op,
        canonicalOp: opName,
        onError,
        status: "applied",
        durationMs: Date.now() - startedAt,
        refAssigned: requestedRef || undefined,
        result: cleanResult
      });

      applied += 1;
    } catch (error) {
      const detail = sanitizeError(error);
      failed += 1;

      opResults.push({
        index,
        op: originalOp.op,
        onError,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: detail
      });

      if (onError !== "continue") {
        aborted = true;
        abortReason = detail.message;
        break;
      }
    }
  }

  if (!dryRun && rollbackRequested && failed > 0) {
    rollback.attempted = true;

    if (checkpoint?.id && checkpoint.restoreSupported) {
      try {
        const restored = await restoreCheckpoint("active", checkpoint.id);
        rollback.restored = Boolean(restored.restored);
        rollback.supported = Boolean(restored.supported);
        rollback.strategy = restored.strategy || rollback.strategy;
        rollback.detail = restored.detail;
      } catch (error) {
        const detail = sanitizeError(error);
        rollback.restored = false;
        rollback.detail = `rollback restore failed: ${detail.message}`;
      }
    } else {
      rollback.restored = false;
      rollback.detail = checkpoint?.id
        ? "Checkpoint exists but is not restorable in this Photoshop state"
        : "No checkpoint available for rollback";
    }
  }

  const detailLines = [];
  detailLines.push(`Executed ${applied + failed}/${ops.length} op(s)`);
  if (failed > 0) {
    detailLines.push(`${failed} failed`);
  }
  if (aborted) {
    detailLines.push(`aborted: ${abortReason}`);
  }
  if (dryRun) {
    detailLines.push("dry-run validation only");
  }

  return {
    transactionId: tx,
    dryRun,
    applied,
    failed,
    aborted,
    checkpointId: checkpoint?.id,
    rollback,
    refs: cloneSerializable(refs),
    opResults,
    capabilities: APPLY_OPS_CAPABILITIES,
    detail: detailLines.join("; ")
  };
}

async function applyOps(payload) {
  validateOperationEnvelopeShape(payload);

  const tx = payload?.transactionId || "tx-unknown";
  const dryRun = Boolean(payload?.safety?.dryRun);
  const result = dryRun
    ? await runOpsCore(payload, { attempt: 1, maxRetries: 1 })
    : await runModalTask(`PSAgent applyOps ${tx}`, ({ attempt, maxRetries }) => runOpsCore(payload, { attempt, maxRetries }), {
      maxRetries: MAX_MODAL_RETRIES,
      timeoutMs: 30000
    });

  pushEvent(
    "info",
    `ops.apply tx=${tx} dryRun=${String(dryRun)} applied=${result?.applied ?? 0} failed=${result?.failed ?? 0} aborted=${String(result?.aborted ?? false)}`
  );

  return result;
}

async function health() {
  const doc = app.activeDocument;
  return {
    ok: true,
    detail: doc ? `activeDocument=${doc.title}` : "Photoshop ready (no active document)",
    docCapabilities: doc
      ? {
          createLayer: typeof doc.createLayer === "function",
          createTextLayer: typeof doc.createTextLayer === "function",
          duplicate: typeof doc.duplicate === "function",
          save: typeof doc.save === "function",
          resizeImage: typeof doc.resizeImage === "function",
          resizeCanvas: typeof doc.resizeCanvas === "function",
          selection: Boolean(doc.selection)
        }
      : undefined,
    bridgeConnected: bridgeState.connected,
    bridgeClientId: bridgeState.clientId,
    bridgeEndpoint: bridgeState.endpoint,
    applyOpsCapabilities: APPLY_OPS_CAPABILITIES
  };
}

async function openDocument(input) {
  if (!input || input === "active") {
    const doc = activeDocumentOrThrow();
    return {
      docRef: "active",
      detail: `Using active document '${doc.title}'`,
      document: serializeDocument(doc)
    };
  }

  const opened = await runModalTask("PSAgent doc.open", async () =>
    runOpenDocumentOp(
      {
        op: "openDocument",
        input
      },
      {
        refs: {}
      }
    )
  );

  return {
    docRef: "active",
    detail: opened.detail,
    document: opened.document
  };
}

async function getManifest(_docRef) {
  const doc = activeDocumentOrThrow();
  const layers = readLayersSafely();

  return {
    docRef: "active",
    width: getDocDimension(doc.width),
    height: getDocDimension(doc.height),
    resolution: toFiniteNumber(doc.resolution, undefined),
    layers: layers.map((layer) => ({ id: layer.id, name: layer.name, type: layer.type, visible: layer.visible }))
  };
}

async function listLayers(_docRef, match) {
  const layers = readLayersSafely();
  if (!match) {
    return { layers };
  }
  const regex = new RegExp(match, "i");
  return { layers: layers.filter((item) => regex.test(item.name)) };
}

async function render(docRef, format, output) {
  return runModalTask("PSAgent render", async () =>
    runExport(
      {
        op: "export",
        docRef,
        format,
        output
      },
      {
        refs: {},
        index: -1,
        tx: "render"
      }
    )
  );
}

async function executeBridgeMethod(method, params = {}) {
  if (method === "health") {
    return health();
  }
  if (method === "doc.open") {
    return openDocument(params.input);
  }
  if (method === "doc.manifest") {
    return getManifest(params.docRef);
  }
  if (method === "layer.list") {
    return listLayers(params.docRef, params.match);
  }
  if (method === "ops.apply") {
    return applyOps(params.payload);
  }
  if (method === "render") {
    return render(params.docRef, params.format, params.output);
  }
  if (method === "checkpoint.create") {
    return runModalTask("PSAgent checkpoint.create", async () => createCheckpoint(params.docRef, params.label));
  }
  if (method === "checkpoint.list") {
    return listCheckpoints(params.docRef);
  }
  if (method === "checkpoint.restore") {
    return runModalTask("PSAgent checkpoint.restore", async () => restoreCheckpoint(params.docRef, params.checkpointId));
  }
  if (method === "events.tail") {
    return tailEvents(params.limit);
  }
  throw new Error(`Unknown bridge method '${method}'`);
}

function normalizeEndpoint(rawEndpoint) {
  const trimmed = String(rawEndpoint || "").trim();
  if (!trimmed) {
    throw new Error("Bridge endpoint is required");
  }

  const prefixed = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(prefixed);
  return url.origin;
}

function endpointCandidates(baseEndpoint) {
  const normalized = normalizeEndpoint(baseEndpoint);
  const url = new URL(normalized);
  const set = new Set([url.origin]);

  if (url.hostname === "127.0.0.1") {
    url.hostname = "localhost";
    set.add(url.origin);
  } else if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
    set.add(url.origin);
  }

  return [...set];
}

async function httpPost(path, payload, endpointOverride) {
  const endpointBase = endpointOverride || bridgeState.endpoint;
  const response = await fetch(`${endpointBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${path}`);
  }
  return response.json();
}

async function connectBridge() {
  if (bridgeState.connected) {
    setConnectionUI(true);
    return {
      ok: true,
      detail: "Bridge already connected",
      endpoint: bridgeState.endpoint,
      clientId: bridgeState.clientId
    };
  }

  const candidates = endpointCandidates(bridgeState.endpoint);
  let lastError = "";

  for (const candidate of candidates) {
    try {
      await httpPost("/bridge/register", { clientId: bridgeState.clientId }, candidate);
      bridgeState.endpoint = candidate;
      bridgeState.connected = true;
      bridgeState.stopRequested = false;
      bridgeState.lastPollError = "";
      setConnectionUI(true);

      pushEvent("info", `bridge connected endpoint=${bridgeState.endpoint}`);
      void pollLoop();

      return {
        ok: true,
        detail: `Bridge connected: ${bridgeState.endpoint}`,
        endpoint: bridgeState.endpoint,
        clientId: bridgeState.clientId
      };
    } catch (error) {
      const message = error?.message || String(error);
      lastError = message;
      pushEvent("warn", `bridge candidate failed endpoint=${candidate} error=${message}`);
      if (!/permission denied/i.test(message)) {
        break;
      }
    }
  }

  bridgeState.connected = false;
  bridgeState.stopRequested = true;
  setConnectionUI(false);

  if (/permission denied/i.test(lastError)) {
    throw new Error(
      `Permission denied to local bridge endpoint. Remove old plugin entries, add this plugin again, restart Photoshop, then retry.`
    );
  }
  throw new Error(lastError || "Unable to connect bridge");
}

function disconnectBridge() {
  bridgeState.stopRequested = true;
  bridgeState.connected = false;
  setConnectionUI(false);
  pushEvent("warn", "bridge disconnected");
  return {
    ok: true,
    detail: "Bridge disconnected"
  };
}

async function autoConnectBridgeOnStartup() {
  if (!AUTO_CONNECT_ON_STARTUP) {
    return;
  }

  for (let attempt = 1; attempt <= AUTO_CONNECT_MAX_ATTEMPTS; attempt += 1) {
    if (bridgeState.connected || bridgeState.stopRequested) {
      return;
    }

    try {
      const result = await connectBridge();
      appendLog("auto", {
        ok: true,
        attempt,
        detail: result.detail
      });
      return;
    } catch (error) {
      const message = error?.message || String(error);
      const isPermissionError = /permission denied/i.test(message);

      if (isPermissionError || attempt >= AUTO_CONNECT_MAX_ATTEMPTS) {
        appendLog("warn", {
          event: "autoConnectFailed",
          attempt,
          message
        });
        return;
      }

      await sleep(AUTO_CONNECT_RETRY_MS);
    }
  }
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
      controller.abort();
    }, timeoutMs)
    : null;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      cache: "no-store",
      signal: controller ? controller.signal : undefined
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function hotReloadPollLoop() {
  if (!HOT_RELOAD_ON_STARTUP || bridgeState.hotReload.running) {
    return;
  }

  bridgeState.hotReload.running = true;
  while (bridgeState.hotReload.running) {
    try {
      const payload = await fetchJsonWithTimeout(
        `${HOT_RELOAD_ENDPOINT}/version?panel=${encodeURIComponent(bridgeState.clientId)}&t=${Date.now()}`,
        HOT_RELOAD_REQUEST_TIMEOUT_MS
      );
      const nextVersion = Number(payload?.version);

      if (Number.isFinite(nextVersion)) {
        if (bridgeState.hotReload.lastSeenVersion === null) {
          bridgeState.hotReload.lastSeenVersion = nextVersion;
          if (!bridgeState.hotReload.firstConnectLogged) {
            appendLog("dev", `hot reload connected (version=${nextVersion})`);
            bridgeState.hotReload.firstConnectLogged = true;
          }
        } else if (nextVersion !== bridgeState.hotReload.lastSeenVersion) {
          const previous = bridgeState.hotReload.lastSeenVersion;
          bridgeState.hotReload.lastSeenVersion = nextVersion;
          appendLog("dev", `hot reload update ${previous} -> ${nextVersion}; reloading panel`);
          location.reload();
          return;
        }
      }

      bridgeState.hotReload.lastError = "";
      await sleep(HOT_RELOAD_POLL_MS);
    } catch (error) {
      bridgeState.hotReload.lastError = getErrorMessage(error);
      await sleep(HOT_RELOAD_RETRY_MS);
    }
  }
}

function startHotReloadOnStartup() {
  if (!HOT_RELOAD_ON_STARTUP) {
    return;
  }
  void hotReloadPollLoop();
}

async function registerBridgeClient() {
  await httpPost("/bridge/register", {
    clientId: bridgeState.clientId
  });
}

async function processBridgeRequest(request) {
  const requestId = request.requestId;
  const method = request.method;
  const params = request.params || {};

  try {
    pushEvent("info", `bridge request method=${method} id=${requestId}`);
    const result = await executeBridgeMethod(method, params);
    await httpPost("/bridge/result", {
      clientId: bridgeState.clientId,
      requestId,
      result
    });
    pushEvent("info", `bridge request completed method=${method} id=${requestId}`);
  } catch (error) {
    const message = error?.message || String(error);
    pushEvent("error", `bridge request failed method=${method} id=${requestId} error=${message}`);
    await httpPost("/bridge/result", {
      clientId: bridgeState.clientId,
      requestId,
      error: {
        message
      }
    });
  }
}

async function pollLoop() {
  while (!bridgeState.stopRequested) {
    try {
      await registerBridgeClient();

      const poll = await httpPost("/bridge/poll", {
        clientId: bridgeState.clientId,
        waitMs: 15000
      });

      const request = poll.request;
      if (request) {
        await processBridgeRequest(request);
      }
      bridgeState.lastPollError = "";
    } catch (error) {
      const message = error?.message || String(error);
      if (message !== bridgeState.lastPollError) {
        pushEvent("error", `bridge poll error: ${message}`);
        bridgeState.lastPollError = message;
      }
      await sleep(1000);
    }
  }

  bridgeState.connected = false;
  setConnectionUI(false);
}

globalThis.psagentBridge = {
  health,
  applyOps,
  connectBridge,
  disconnectBridge,
  openDocument,
  getManifest,
  listLayers,
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint
};

document.getElementById("connectBtn").addEventListener("click", async () => {
  try {
    const result = bridgeState.connected ? disconnectBridge() : await connectBridge();
    appendLog("ui", result);
  } catch (error) {
    appendLog("error", { error: error?.message || String(error) });
  }
});

document.getElementById("clearLogBtn").addEventListener("click", () => {
  clearLogPanel();
});

initializeLogPanel();
setConnectionUI(false);
startHotReloadOnStartup();
void autoConnectBridgeOnStartup();
