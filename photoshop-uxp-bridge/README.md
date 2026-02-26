# PSAgent UXP bridge

Photoshop UXP panel plugin (`PSAgent Bridge`) that exposes runtime APIs on `globalThis.psagentBridge` and connects to the psagent daemon over `/bridge/*` polling.

## Runtime methods

- `health()`
- `applyOps(payload)`
- `connectBridge()`
- `disconnectBridge()`
- `openDocument(input)`
- `getManifest(docRef)`
- `listLayers(docRef, match?)`
- `createCheckpoint(docRef, label?)`
- `listCheckpoints(docRef)`
- `restoreCheckpoint(docRef, checkpointId)`

Panel startup attempts to auto-connect to the local bridge endpoint with bounded retries.

## `applyOps` execution model

`applyOps(payload)` now supports agent-oriented execution features:

- Op-local refs map:
  - assign refs with `ref|refId|as|outputRef|storeAs` on an op
  - resolve refs in later ops using `$name` or `$name.path`
- Per-op error policy:
  - `onError: "continue" | "abort"`
  - default from `payload.safety.onError` (fallback `abort`)
- Safety/rollback:
  - `payload.safety.rollbackOnError` enables best-effort rollback
  - uses checkpoint strategy: history snapshot first, history-state pointer fallback
  - reports capability + behavior in result payload
- Structured result payload:
  - `applied`, `failed`, `aborted`
  - `opResults[]` (per-op status/result/error)
  - `refs` (resolved ref map)
  - `rollback` metadata
- Contract validation:
  - envelope shape checks (`transactionId`, `doc`, non-empty `ops[]`, valid `onError`)
  - per-op preflight checks (active document/layer target requirements, required input fields)
- Modal safety wrapper:
  - all mutating execution runs through one modal retry wrapper
  - retries modal-busy collisions and normalizes common Photoshop state errors

## Supported op families

The executor supports the full bridge operation surface with DOM-first implementation and batchPlay fallback where needed:

- Documents:
  - `createDocument`, `openDocument`, `duplicateDocument`, `saveDocument`, `closeDocument`
  - `resizeImage`, `resizeCanvas`, `cropDocument`, `trimDocument`, `rotateDocument`, `flattenDocument`, `mergeVisible`
- Layers:
  - `createLayer`, `createPixelLayer`, `createGroup`, `groupLayers`
  - `deleteLayer`, `renameLayer`, `duplicateLayer`, `selectLayer`, `moveLayer`
  - `setLayerVisibility`, `setLayerOpacity`, `setBlendMode`, `bringLayerToFront`, `sendLayerToBack`
  - `mergeLayer`, `rasterizeLayer`, `linkLayers`, `unlinkLayer`
- Transform/layout:
  - `transformLayer`, `translateLayer`, `scaleLayer`, `rotateLayer`, `flipLayer`, `skewLayer`
- Smart object:
  - `convertToSmartObject`, `replaceSmartObject`, `relinkSmartObject`, `editSmartObject`
- Selection/masks/filters:
  - `selectAll`, `deselect`, `inverseSelection`, `featherSelection`, `expandSelection`, `contractSelection`, `growSelection`, `smoothSelection`
  - `selectRectangle`, `selectEllipse`, `selectPolygon`, `selectLayerPixels`
  - `createLayerMask`, `deleteLayerMask`, `applyLayerMask`
  - `applyGaussianBlur`, `applyUnsharpMask`, `applySharpen`, `applyBlur`
- Shapes/text:
  - `createTextLayer`, `setText`, `setTextStyle`, `createShapeLayer`
- Export and raw action descriptors:
  - `export`
  - `batchPlay`

Aliases like `doc.*`, `layer.*`, `selection.*`, `smartObject.*`, and `filter.*` are normalized to canonical ops.

## Important transform and layout semantics

- `transformLayer`:
  - legacy behavior remains: `x/y` are translation deltas for translate-only transforms
  - absolute positioning supported via:
    - `absolute: true` + `x/y`, or
    - `position: { x, y, align? }`
  - when non-translation transforms are present (`scale*`, `rotate`, `flip`, `skew*`), `x/y` are treated as absolute coordinates by default
- `placeAsset`:
  - remote assets can normalize to source pixel dimensions (`normalizePixels`, default `true`)
  - optional fit controls:
    - `fit: "cover" | "contain" | "stretch" | "none"`
    - `fitRect`/`frame`/`targetRect` (`x,y,width,height` or `left,top,right,bottom`)
    - `fitTo: "canvas"` (or `fitCanvas: true`)
    - `fitAlign`/`align` (`center`, `top-left`, `top`, `top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right`)
- text ops (`createTextLayer`/`setTextStyle`):
  - optional bounds-fit: `maxWidth`, `maxHeight`, `minFontSize`
  - optional collision avoidance: `avoidOverlapWith`, `overlapGap`

## BatchPlay diagnostics

BatchPlay handling now inspects both thrown errors and returned descriptor arrays for embedded `_obj: "error"`/negative `result` descriptors and surfaces indexed descriptor failures in bridge responses.

## Compatibility / limitations (real Photoshop)

- Rollback is best-effort:
  - snapshot creation can fail in some docs/states
  - history states can be pruned, making pointer restore unavailable
- Smart object, mask, shape, and some export flows rely on Action Manager descriptors that can vary by Photoshop version/state.
- Path-based file operations depend on UXP filesystem permissions and path accessibility in the plugin host.
- Layer-targeted `export` via `exportSelectionAsFileTypePressed` exports to destination folder; final filename is Photoshop-controlled.

## Load in Photoshop (development)

1. Open UXP Developer Tool.
2. Add this folder as a plugin.
3. Load/reload plugin.
4. Open panel in Photoshop. It auto-connects on startup.
5. If needed, click **Connect Bridge** manually.

## Hot reload model (development)

The panel includes a lightweight hot-reload client:

- Polls `http://127.0.0.1:43121/version` in development.
- Calls `location.reload()` when the reported version changes.

Run local watcher server from repo root:

```bash
npm run bridge:hotreload
```
