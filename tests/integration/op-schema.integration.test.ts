import assert from "node:assert/strict";
import test from "node:test";
import { validateOperationEnvelope } from "../../psagent/src/core/validate-ops.js";

const baseEnvelope = {
  transactionId: "schema-sync-001",
  doc: { ref: "active" }
};

test("validator accepts docs-listed operation payloads that previously failed stale schema checks", () => {
  const payload = {
    ...baseEnvelope,
    ops: [
      {
        op: "createDocument",
        name: "Schema Sync",
        width: 1080,
        height: 1080,
        resolution: 72,
        mode: "rgbColor",
        fill: "white"
      },
      {
        op: "createTextLayer",
        name: "Headline",
        text: "Summer Launch",
        fontSize: 72,
        fontName: "Arial-BoldMT",
        maxWidth: 860,
        position: { x: 96, y: 220 },
        ref: "headline"
      },
      {
        op: "setLayerOpacity",
        target: "$headline",
        opacity: 80
      },
      {
        op: "setBlendMode",
        target: "$headline",
        blendMode: "multiply"
      },
      {
        op: "translateLayer",
        target: "$headline",
        x: 12,
        y: -8
      },
      {
        op: "createShapeLayer",
        name: "Badge",
        x: 40,
        y: 40,
        width: 240,
        height: 96,
        cornerRadius: 48,
        fillType: "gradient",
        gradient: {
          from: "#22c55e",
          to: "#15803d",
          angle: 90
        }
      },
      {
        op: "createAdjustmentLayer",
        type: "brightnessContrast",
        adjustment: {
          brightness: 10,
          contrast: 5
        }
      },
      {
        op: "addLayerMask",
        target: "$headline",
        outputRef: "maskRef"
      },
      {
        op: "createClippingMask",
        target: "$headline"
      },
      {
        op: "setLayerEffects",
        target: "$headline",
        dropShadow: {
          color: "#000000",
          opacity: 45,
          distance: 10,
          size: 18
        }
      },
      {
        op: "applyAddNoise",
        target: "$headline",
        amount: 4,
        distribution: "uniform",
        monochromatic: true
      }
    ]
  };

  assert.doesNotThrow(() => validateOperationEnvelope(payload));
});

test("validator accepts alias operation names included in docs metadata", () => {
  const payload = {
    ...baseEnvelope,
    transactionId: "schema-sync-002",
    ops: [
      {
        op: "flattenImage"
      },
      {
        op: "invertSelection"
      },
      {
        op: "layer.opacity",
        target: { layerName: "Hero" },
        opacity: 90
      }
    ]
  };

  assert.doesNotThrow(() => validateOperationEnvelope(payload));
});

test("validator rejects unknown operation names", () => {
  const payload = {
    ...baseEnvelope,
    transactionId: "schema-sync-003",
    ops: [
      {
        op: "totallyUnknownOperation",
        foo: "bar"
      }
    ]
  };

  assert.throws(() => validateOperationEnvelope(payload), /Invalid operations payload/u);
});

test("validator accepts safety.opDelayMs and rejects invalid values", () => {
  const validPayload = {
    ...baseEnvelope,
    transactionId: "schema-sync-004",
    ops: [{ op: "createLayer", name: "Paced Layer" }],
    safety: {
      onError: "abort",
      opDelayMs: 120
    }
  };

  assert.doesNotThrow(() => validateOperationEnvelope(validPayload));

  const invalidPayload = {
    ...baseEnvelope,
    transactionId: "schema-sync-005",
    ops: [{ op: "createLayer", name: "Broken Pace" }],
    safety: {
      opDelayMs: -1
    }
  };

  assert.throws(() => validateOperationEnvelope(invalidPayload), /Invalid operations payload/u);
});
