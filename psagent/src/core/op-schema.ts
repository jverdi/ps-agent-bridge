const refNamePattern = "^[A-Za-z_][A-Za-z0-9_-]*$";

const operationControlProperties = {
  ref: { type: "string", pattern: refNamePattern },
  onError: { type: "string", enum: ["abort", "continue"] }
} as const;

const layerTargetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    layerName: { type: "string", minLength: 1 },
    layerId: { type: "string", minLength: 1 }
  },
  anyOf: [{ required: ["layerName"] }, { required: ["layerId"] }]
} as const;

const layerReferenceSchema = {
  oneOf: [layerTargetSchema, { type: "string", minLength: 1 }]
} as const;

const positionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    x: { type: "number" },
    y: { type: "number" }
  }
} as const;

const layerReferenceArraySchema = {
  type: "array",
  minItems: 1,
  items: layerReferenceSchema
} as const;

function opSchema(required: string[], properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["op", ...required],
    properties: {
      ...operationControlProperties,
      ...properties
    }
  };
}

function looseOpSchema(required: string[], properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: true,
    required: ["op", ...required],
    properties: {
      ...operationControlProperties,
      ...properties
    }
  };
}

const operationsSchema = [
  looseOpSchema([], {
    op: { const: "createDocument" },
    name: { type: "string", minLength: 1 },
    width: { type: "number", exclusiveMinimum: 0 },
    height: { type: "number", exclusiveMinimum: 0 },
    resolution: { type: "number", exclusiveMinimum: 0 },
    mode: { type: "string", minLength: 1 },
    fill: { type: "string", minLength: 1 }
  }),
  looseOpSchema([], {
    op: { const: "closeDocument" },
    docRef: { type: "string", minLength: 1 },
    save: { type: "boolean" },
    saveOption: { type: "string", minLength: 1 },
    mode: { type: "string", minLength: 1 },
    output: { type: "string", minLength: 1 }
  }),
  looseOpSchema([], {
    op: { const: "saveDocument" },
    docRef: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    output: { type: "string", minLength: 1 },
    format: { type: "string", minLength: 1 },
    quality: { type: "number", minimum: 0 },
    asCopy: { type: "boolean" }
  }),
  looseOpSchema(["output"], {
    op: { const: "saveDocumentAs" },
    docRef: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    output: { type: "string", minLength: 1 },
    format: { type: "string", minLength: 1 },
    quality: { type: "number", minimum: 0 },
    asCopy: { type: "boolean" }
  }),
  looseOpSchema([], {
    op: { const: "duplicateDocument" },
    docRef: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 }
  }),
  opSchema([], {
    op: { const: "createLayer" },
    name: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ["pixel", "smartObject", "shape"] },
    parent: layerReferenceSchema,
    at: { type: "integer", minimum: 0 }
  }),
  opSchema(["name"], {
    op: { const: "createGroup" },
    name: { type: "string", minLength: 1 },
    parent: layerReferenceSchema,
    at: { type: "integer", minimum: 0 }
  }),
  opSchema(["targets"], {
    op: { const: "groupLayers" },
    targets: layerReferenceArraySchema,
    name: { type: "string", minLength: 1 }
  }),
  opSchema(["target"], {
    op: { const: "ungroupLayer" },
    target: layerReferenceSchema
  }),
  opSchema(["target"], {
    op: { const: "deleteLayer" },
    target: layerReferenceSchema
  }),
  opSchema(["target", "name"], {
    op: { const: "renameLayer" },
    target: layerReferenceSchema,
    name: { type: "string", minLength: 1 }
  }),
  opSchema(["target"], {
    op: { const: "duplicateLayer" },
    target: layerReferenceSchema,
    name: { type: "string", minLength: 1 },
    parent: layerReferenceSchema,
    at: { type: "integer", minimum: 0 }
  }),
  looseOpSchema(["target"], {
    op: { const: "moveLayer" },
    target: layerReferenceSchema,
    parent: layerReferenceSchema,
    at: { type: "integer", minimum: 0 },
    index: { type: "integer", minimum: 0 },
    to: { type: "string", minLength: 1 },
    placement: { type: "string", minLength: 1 },
    insertLocation: { type: "string", minLength: 1 },
    relativeTo: layerReferenceSchema,
    by: {
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "number" },
        y: { type: "number" }
      }
    }
  }),
  {
    ...opSchema(["target"], {
      op: { const: "reorderLayer" },
      target: layerReferenceSchema,
      before: layerReferenceSchema,
      after: layerReferenceSchema,
      at: { type: "integer", minimum: 0 }
    }),
    anyOf: [{ required: ["before"] }, { required: ["after"] }, { required: ["at"] }]
  },
  opSchema(["text"], {
    op: { const: "createTextLayer" },
    name: { type: "string", minLength: 1 },
    text: { type: "string" },
    fontSize: { type: "number", minimum: 1 },
    parent: layerReferenceSchema,
    at: { type: "integer", minimum: 0 },
    position: positionSchema
  }),
  looseOpSchema([], {
    op: { const: "createShapeLayer" },
    name: { type: "string", minLength: 1 },
    shape: { type: "string", enum: ["rectangle", "ellipse", "path"] },
    fillColor: { type: "string", minLength: 1 },
    strokeColor: { type: "string", minLength: 1 },
    parent: layerReferenceSchema,
    at: { type: "integer", minimum: 0 }
  }),
  opSchema(["targets"], {
    op: { const: "selectLayers" },
    targets: layerReferenceArraySchema,
    mode: { type: "string", enum: ["set", "add", "remove"] }
  }),
  opSchema(["target", "visible"], {
    op: { const: "setVisibility" },
    target: layerReferenceSchema,
    visible: { type: "boolean" }
  }),
  opSchema(["target", "locked"], {
    op: { const: "setLocked" },
    target: layerReferenceSchema,
    locked: { type: "boolean" }
  }),
  opSchema(["target", "opacity"], {
    op: { const: "setOpacity" },
    target: layerReferenceSchema,
    opacity: { type: "number", minimum: 0, maximum: 100 }
  }),
  opSchema(["target", "blendMode"], {
    op: { const: "setBlendMode" },
    target: layerReferenceSchema,
    blendMode: { type: "string", minLength: 1 }
  }),
  looseOpSchema(["target"], {
    op: { const: "setLayerProps" },
    target: layerReferenceSchema,
    visible: { type: "boolean" },
    locked: { type: "boolean" },
    opacity: { type: "number", minimum: 0, maximum: 100 },
    blendMode: { type: "string", minLength: 1 }
  }),
  opSchema(["target", "text"], {
    op: { const: "setText" },
    target: layerReferenceSchema,
    text: { type: "string" },
    fontSize: { type: "number", minimum: 1 },
    position: positionSchema
  }),
  opSchema(["target", "input"], {
    op: { const: "replaceSmartObject" },
    target: layerReferenceSchema,
    input: { type: "string", minLength: 1 },
    linked: { type: "boolean" }
  }),
  opSchema(["target"], {
    op: { const: "convertToSmartObject" },
    target: layerReferenceSchema
  }),
  opSchema(["target", "input"], {
    op: { const: "relinkSmartObject" },
    target: layerReferenceSchema,
    input: { type: "string", minLength: 1 }
  }),
  opSchema(["target"], {
    op: { const: "rasterizeLayer" },
    target: layerReferenceSchema
  }),
  {
    ...opSchema(["targets"], {
      op: { const: "mergeLayers" },
      targets: {
        ...layerReferenceArraySchema,
        minItems: 2
      },
      name: { type: "string", minLength: 1 }
    })
  },
  opSchema([], {
    op: { const: "flattenImage" },
    name: { type: "string", minLength: 1 }
  }),
  looseOpSchema(["target"], {
    op: { const: "transformLayer" },
    target: layerReferenceSchema
  }),
  looseOpSchema([], {
    op: { const: "alignLayers" },
    axis: { type: "string", minLength: 1 },
    targets: layerReferenceArraySchema
  }),
  looseOpSchema([], {
    op: { const: "distributeLayers" },
    axis: { type: "string", minLength: 1 },
    targets: layerReferenceArraySchema
  }),
  looseOpSchema([], {
    op: { const: "resizeCanvas" },
    width: { type: "number", exclusiveMinimum: 0 },
    height: { type: "number", exclusiveMinimum: 0 }
  }),
  looseOpSchema([], {
    op: { const: "resizeImage" },
    width: { type: "number", exclusiveMinimum: 0 },
    height: { type: "number", exclusiveMinimum: 0 },
    resolution: { type: "number", exclusiveMinimum: 0 }
  }),
  looseOpSchema([], {
    op: { const: "cropDocument" }
  }),
  looseOpSchema(["input"], {
    op: { const: "placeAsset" },
    input: { type: "string", minLength: 1 },
    linked: { type: "boolean" },
    name: { type: "string", minLength: 1 }
  }),
  looseOpSchema([], {
    op: { const: "createAdjustmentLayer" },
    adjustment: { type: "string", minLength: 1 }
  }),
  looseOpSchema(["filter"], {
    op: { const: "applyFilter" },
    filter: { type: "string", minLength: 1 },
    target: layerReferenceSchema
  }),
  opSchema(["target"], {
    op: { const: "addLayerMask" },
    target: layerReferenceSchema
  }),
  opSchema(["target"], {
    op: { const: "removeLayerMask" },
    target: layerReferenceSchema
  }),
  opSchema(["target"], {
    op: { const: "applyLayerMask" },
    target: layerReferenceSchema
  }),
  looseOpSchema([], {
    op: { const: "setSelection" }
  }),
  looseOpSchema([], {
    op: { const: "modifySelection" },
    mode: { type: "string", minLength: 1 }
  }),
  looseOpSchema([], {
    op: { const: "invertSelection" }
  }),
  opSchema(["commands"], {
    op: { const: "batchPlay" },
    commands: {
      type: "array",
      minItems: 1
    }
  }),
  looseOpSchema(["target"], {
    op: { const: "setTextStyle" },
    target: layerReferenceSchema
  }),
  looseOpSchema(["format", "output"], {
    op: { const: "export" },
    format: {
      type: "string",
      enum: ["png", "jpg"]
    },
    output: { type: "string", minLength: 1 },
    target: layerReferenceSchema,
    scale: { type: "number", exclusiveMinimum: 0 }
  }),
  looseOpSchema(["format", "output"], {
    op: { const: "exportDocument" },
    format: {
      type: "string",
      enum: ["png", "jpg"]
    },
    output: { type: "string", minLength: 1 }
  }),
  looseOpSchema(["target", "format", "output"], {
    op: { const: "exportLayer" },
    target: layerReferenceSchema,
    format: {
      type: "string",
      enum: ["png", "jpg"]
    },
    output: { type: "string", minLength: 1 }
  }),
  looseOpSchema(["match", "format", "outputDir"], {
    op: { const: "exportLayersByName" },
    match: { type: "string", minLength: 1 },
    format: {
      type: "string",
      enum: ["png", "jpg"]
    },
    outputDir: { type: "string", minLength: 1 }
  })
];

export const operationEnvelopeSchema = {
  $id: "https://psagent.dev/schemas/operation-envelope.json",
  type: "object",
  additionalProperties: false,
  required: ["transactionId", "doc", "ops"],
  properties: {
    transactionId: {
      type: "string",
      minLength: 1
    },
    doc: {
      type: "object",
      additionalProperties: false,
      required: ["ref"],
      properties: {
        ref: {
          type: "string",
          minLength: 1
        }
      }
    },
    refs: {
      type: "object",
      propertyNames: {
        pattern: refNamePattern
      },
      additionalProperties: {
        type: "string",
        minLength: 1
      }
    },
    ops: {
      type: "array",
      minItems: 1,
      items: {
        oneOf: operationsSchema
      }
    },
    safety: {
      type: "object",
      additionalProperties: false,
      properties: {
        dryRun: { type: "boolean" },
        checkpoint: { type: "boolean" },
        rollbackOnError: { type: "boolean" },
        continueOnError: { type: "boolean" },
        onError: { type: "string", enum: ["abort", "continue"] }
      }
    }
  }
} as const;
