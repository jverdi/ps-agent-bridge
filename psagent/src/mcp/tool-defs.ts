export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const toolDefinitions: ToolDef[] = [
  {
    name: "photoshop_capabilities",
    description: "Return current adapter capabilities",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "photoshop_open_document",
    description: "Open a document by local path or URL",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["input"],
      properties: {
        input: { type: "string" }
      }
    }
  },
  {
    name: "photoshop_get_manifest",
    description: "Get PSD manifest for active document or provided ref",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        docRef: { type: "string" }
      }
    }
  },
  {
    name: "photoshop_query_layers",
    description: "List layers with optional regex filter",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        docRef: { type: "string" },
        match: { type: "string" }
      }
    }
  },
  {
    name: "photoshop_apply_ops",
    description: "Apply an operations envelope payload",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["payload"],
      properties: {
        payload: {
          type: "object"
        }
      }
    }
  },
  {
    name: "photoshop_render",
    description: "Render active document to an output file",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["format", "output"],
      properties: {
        docRef: { type: "string" },
        format: { type: "string", enum: ["png", "jpg"] },
        output: { type: "string" }
      }
    }
  },
  {
    name: "photoshop_checkpoint_restore",
    description: "Restore a named checkpoint",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        docRef: { type: "string" },
        id: { type: "string" }
      }
    }
  },
  {
    name: "photoshop_events_tail",
    description: "Fetch recent adapter events",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        count: { type: "integer", minimum: 1 }
      }
    }
  }
];
