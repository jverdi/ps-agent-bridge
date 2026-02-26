import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionState } from "../types.js";

function ensureDirFor(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeReadJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeWriteJson(filePath: string, value: unknown): void {
  ensureDirFor(filePath);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function getSessionFilePath(): string {
  return path.join(os.homedir(), ".psagent", "session.json");
}

export function loadSession(): SessionState | null {
  return safeReadJson<SessionState>(getSessionFilePath());
}

export function saveSession(session: SessionState): void {
  safeWriteJson(getSessionFilePath(), session);
}

export function updateSession(mutator: (session: SessionState | null) => SessionState): SessionState {
  const next = mutator(loadSession());
  saveSession(next);
  return next;
}

export function readConfigFile<T>(filePath: string): T | null {
  return safeReadJson<T>(filePath);
}
