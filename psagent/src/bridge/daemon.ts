import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

interface RpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface BridgeRequest {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
  createdAt: string;
}

interface BridgeClient {
  id: string;
  lastSeenAt: number;
  queue: BridgeRequest[];
  pollWaiters: Array<(request: BridgeRequest | null) => void>;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface EventItem {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}

const CLIENT_STALE_MS = 20_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;

function setCorsHeaders(res: import("node:http").ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function json(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  setCorsHeaders(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

export function startBridgeDaemon(port: number): void {
  const clients = new Map<string, BridgeClient>();
  const pending = new Map<string, PendingRpc>();
  const events: EventItem[] = [];

  let activeClientId: string | null = null;

  function pushEvent(level: EventItem["level"], message: string): void {
    events.push({ timestamp: new Date().toISOString(), level, message });
    if (events.length > 500) {
      events.shift();
    }
  }

  function getOrCreateClient(id: string): BridgeClient {
    const existing = clients.get(id);
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing;
    }

    const next: BridgeClient = {
      id,
      lastSeenAt: Date.now(),
      queue: [],
      pollWaiters: []
    };
    clients.set(id, next);
    return next;
  }

  function setActiveClient(id: string): void {
    activeClientId = id;
    pushEvent("info", `active client set: ${id}`);
  }

  function getActiveClient(): BridgeClient | null {
    if (!activeClientId) {
      return null;
    }
    const client = clients.get(activeClientId);
    if (!client) {
      activeClientId = null;
      return null;
    }
    if (Date.now() - client.lastSeenAt > CLIENT_STALE_MS) {
      pushEvent("warn", `client stale: ${client.id}`);
      activeClientId = null;
      return null;
    }
    return client;
  }

  async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  function enqueueForActiveClient(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<unknown> {
    const client = getActiveClient();
    if (!client) {
      throw new Error("No active Photoshop bridge client. Open the UXP panel and click Connect.");
    }

    const requestId = randomUUID();
    const request: BridgeRequest = {
      requestId,
      method,
      params,
      createdAt: new Date().toISOString()
    };

    pushEvent("info", `enqueue method=${method} requestId=${requestId} client=${client.id}`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Bridge request timed out for method=${method}`));
      }, timeoutMs);

      pending.set(requestId, { resolve, reject, timeout });

      if (client.pollWaiters.length > 0) {
        const waiter = client.pollWaiters.shift();
        waiter?.(request);
      } else {
        client.queue.push(request);
      }
    });
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        setCorsHeaders(res);
        res.statusCode = 204;
        res.end();
        return;
      }

      const path = req.url ?? "";

      if (req.method === "POST" && path === "/bridge/register") {
        const body = JSON.parse(await readBody(req)) as { clientId?: string };
        const clientId = body.clientId?.trim();
        if (!clientId) {
          json(res, 400, { error: "clientId is required" });
          return;
        }

        const client = getOrCreateClient(clientId);
        setActiveClient(client.id);

        json(res, 200, {
          ok: true,
          activeClientId,
          queueDepth: client.queue.length
        });
        return;
      }

      if (req.method === "POST" && path === "/bridge/poll") {
        const body = JSON.parse(await readBody(req)) as { clientId?: string; waitMs?: number };
        const clientId = body.clientId?.trim();
        if (!clientId) {
          json(res, 400, { error: "clientId is required" });
          return;
        }

        const waitMs = Math.min(Math.max(Number(body.waitMs ?? 15_000), 0), 60_000);
        const client = getOrCreateClient(clientId);
        setActiveClient(client.id);

        if (client.queue.length > 0) {
          const request = client.queue.shift() ?? null;
          json(res, 200, { request });
          return;
        }

        if (waitMs === 0) {
          json(res, 200, { request: null });
          return;
        }

        const timeout = setTimeout(() => {
          const idx = client.pollWaiters.indexOf(waiter);
          if (idx >= 0) {
            client.pollWaiters.splice(idx, 1);
          }
          json(res, 200, { request: null });
        }, waitMs);

        const waiter = (request: BridgeRequest | null) => {
          clearTimeout(timeout);
          json(res, 200, { request });
        };

        client.pollWaiters.push(waiter);
        return;
      }

      if (req.method === "POST" && path === "/bridge/result") {
        const body = JSON.parse(await readBody(req)) as {
          clientId?: string;
          requestId?: string;
          result?: unknown;
          error?: { message?: string; code?: number };
        };

        const clientId = body.clientId?.trim();
        const requestId = body.requestId?.trim();
        if (!clientId || !requestId) {
          json(res, 400, { error: "clientId and requestId are required" });
          return;
        }

        const client = getOrCreateClient(clientId);
        setActiveClient(client.id);

        const pendingRpc = pending.get(requestId);
        if (!pendingRpc) {
          json(res, 404, { error: `Unknown requestId ${requestId}` });
          return;
        }

        clearTimeout(pendingRpc.timeout);
        pending.delete(requestId);

        if (body.error?.message) {
          pushEvent("error", `requestId=${requestId} error=${body.error.message}`);
          pendingRpc.reject(new Error(body.error.message));
        } else {
          pushEvent("info", `requestId=${requestId} completed`);
          pendingRpc.resolve(body.result);
        }

        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && path === "/bridge/status") {
        const active = getActiveClient();
        json(res, 200, {
          ok: true,
          activeClientId: active?.id ?? null,
          activeConnected: Boolean(active),
          clientCount: clients.size,
          pendingRpc: pending.size,
          events: events.slice(-20)
        });
        return;
      }

      if (req.method === "POST" && path === "/rpc") {
        const rpc = JSON.parse(await readBody(req)) as RpcRequest;
        const method = rpc.method?.trim();
        const params = rpc.params ?? {};

        if (!method) {
          json(res, 400, {
            id: rpc.id ?? null,
            error: {
              code: -32600,
              message: "method is required"
            }
          });
          return;
        }

        if (method === "health") {
          const active = getActiveClient();
          if (!active) {
            json(res, 200, {
              id: rpc.id ?? null,
              result: {
                ok: false,
                detail: "Bridge daemon up; no active UXP client"
              }
            });
            return;
          }
        }

        try {
          const result = await enqueueForActiveClient(method, params, DEFAULT_RPC_TIMEOUT_MS);
          json(res, 200, {
            id: rpc.id ?? null,
            result
          });
        } catch (error) {
          json(res, 500, {
            id: rpc.id ?? null,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (error) {
      json(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`bridge daemon listening on http://127.0.0.1:${port}\n`);
    process.stdout.write(`plugin endpoints: POST /bridge/register, /bridge/poll, /bridge/result\n`);
    process.stdout.write(`cli endpoint: POST /rpc\n`);
  });
}
