#!/usr/bin/env node

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

function parseArgs(argv) {
  const out = {
    port: Number(process.env.PSAGENT_HOT_RELOAD_PORT || 43121),
    pollMs: Number(process.env.PSAGENT_HOT_RELOAD_POLL_MS || 700),
    dir: process.env.PSAGENT_HOT_RELOAD_DIR || ""
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      out.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--poll-ms") {
      out.pollMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--dir") {
      out.dir = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(out.port) || out.port <= 0) {
    throw new Error(`Invalid --port value '${String(out.port)}'`);
  }
  if (!Number.isFinite(out.pollMs) || out.pollMs < 100) {
    throw new Error(`Invalid --poll-ms value '${String(out.pollMs)}'`);
  }

  return out;
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function nowIso() {
  return new Date().toISOString();
}

async function fileFingerprint(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return "missing";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../..");
  const pluginDir = args.dir ? path.resolve(args.dir) : path.join(repoRoot, "photoshop-uxp-bridge");
  const trackedFiles = ["index.js", "index.html", "manifest.json"].map((name) => path.join(pluginDir, name));

  let version = Date.now();
  let updatedAt = nowIso();
  const snapshots = new Map();

  for (const filePath of trackedFiles) {
    snapshots.set(filePath, await fileFingerprint(filePath));
  }

  async function checkForChanges() {
    let changed = false;
    for (const filePath of trackedFiles) {
      const next = await fileFingerprint(filePath);
      const prev = snapshots.get(filePath);
      if (next !== prev) {
        snapshots.set(filePath, next);
        changed = true;
      }
    }

    if (changed) {
      version += 1;
      updatedAt = nowIso();
      process.stdout.write(`[hot-reload] version=${version} updatedAt=${updatedAt}\n`);
    }
  }

  const timer = setInterval(() => {
    void checkForChanges();
  }, args.pollMs);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/version" || url.pathname === "/health")) {
      json(res, 200, {
        ok: true,
        version,
        updatedAt,
        pluginDir,
        files: trackedFiles.map((entry) => path.relative(pluginDir, entry))
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/bump") {
      version += 1;
      updatedAt = nowIso();
      json(res, 200, { ok: true, version, updatedAt });
      return;
    }

    json(res, 404, {
      ok: false,
      error: "Not found"
    });
  });

  server.listen(args.port, "127.0.0.1", () => {
    process.stdout.write(`[hot-reload] listening on http://127.0.0.1:${args.port}/version\n`);
    process.stdout.write(`[hot-reload] watching ${pluginDir}\n`);
  });

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
