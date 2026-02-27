import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
  json?: unknown;
}

interface IntegrationHarness {
  fixturePath(name: string): string;
  runJson(args: string[]): Promise<CliRunResult>;
}

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const expectedPlannedOps = [
  "createDocument",
  "closeDocument",
  "saveDocument",
  "saveDocumentAs",
  "duplicateDocument",
  "createLayer",
  "duplicateLayer",
  "moveLayer",
  "setLayerProps",
  "groupLayers",
  "ungroupLayer",
  "mergeLayers",
  "flattenImage",
  "selectLayers",
  "deleteLayer",
  "renameLayer",
  "transformLayer",
  "alignLayers",
  "distributeLayers",
  "resizeCanvas",
  "resizeImage",
  "cropDocument",
  "placeAsset",
  "convertToSmartObject",
  "replaceSmartObject",
  "relinkSmartObject",
  "createAdjustmentLayer",
  "applyFilter",
  "addLayerMask",
  "removeLayerMask",
  "applyLayerMask",
  "setSelection",
  "modifySelection",
  "invertSelection",
  "createShapeLayer",
  "createTextLayer",
  "setText",
  "setTextStyle",
  "exportDocument",
  "exportLayer",
  "exportLayersByName",
  "batchPlay"
].sort();

const expectedExtendedOps = [
  "createDocument",
  "createLayer",
  "changeDocumentMode",
  "convertColorProfile",
  "calculations",
  "applyImage",
  "sampleColor",
  "createLayerComp",
  "applyLayerComp",
  "recaptureLayerComp",
  "deleteLayerComp",
  "createAdjustmentLayer",
  "setAdjustmentLayer",
  "applyMotionBlur",
  "applySmartBlur",
  "applyHighPass",
  "applyMedianNoise",
  "applyMinimum",
  "applyMaximum",
  "applyDustAndScratches",
  "setSelection",
  "createChannel",
  "duplicateChannel",
  "saveSelection",
  "saveSelectionTo",
  "loadSelection",
  "deleteChannel",
  "createPath",
  "makeSelectionFromPath",
  "fillPath",
  "strokePath",
  "makeClippingPath",
  "makeWorkPathFromSelection",
  "deletePath",
  "addGuide",
  "removeGuide",
  "clearGuides",
  "getPixels",
  "getSelectionPixels",
  "getLayerMaskPixels",
  "putPixels",
  "putSelectionPixels",
  "putLayerMaskPixels",
  "encodeImageData",
  "playAction",
  "playActionSet",
  "splitChannels",
  "closeDocument"
].sort();

const expectedWave2Ops = [
  "createDocument",
  "createLayer",
  "createTextLayer",
  "createPathFromPoints",
  "setPathPoints",
  "setTextWarp",
  "setTextOnPath",
  "createArtboard",
  "resizeArtboard",
  "reorderArtboards",
  "selectSubject",
  "selectColorRange",
  "refineSelection",
  "createVectorMask",
  "deleteVectorMask",
  "autoAlignLayers",
  "autoBlendLayers",
  "contentAwareFill",
  "contentAwareScale",
  "contentAwareMove",
  "createHistorySnapshot",
  "listHistoryStates",
  "restoreHistoryState",
  "suspendHistory",
  "exportArtboards",
  "closeDocument"
].sort();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve free port"));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function runCliJson(args: string[], env: NodeJS.ProcessEnv): Promise<CliRunResult> {
  return runCli(["--json", ...args], env);
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "psagent/src/cli.ts", ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", reject);
    child.once("close", (code) => {
      let json: unknown;
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          json = undefined;
        }
      }
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        json
      });
    });
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await Promise.race([once(child, "exit").then(() => true), delay(2_000).then(() => false)]);

  if (!exited) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function startMockBridge(port: number, env: NodeJS.ProcessEnv): Promise<{ stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ["--import", "tsx", "psagent/src/cli.ts", "bridge", "mock", "--port", String(port)], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  await new Promise<void>((resolve, reject) => {
    const readyLine = `mock bridge listening on http://127.0.0.1:${port}/rpc`;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Mock bridge did not start in time. stdout=${stdout} stderr=${stderr}`));
    }, 8_000);

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(readyLine)) {
        cleanup();
        resolve();
      }
    };

    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Mock bridge exited before ready. code=${String(code)} signal=${String(signal)} stdout=${stdout} stderr=${stderr}`));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    function cleanup(): void {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });

  return {
    stop: async () => {
      await stopProcess(child);
    }
  };
}

function assertSuccess(result: CliRunResult, message: string): asserts result is CliRunResult & { json: Record<string, unknown> } {
  assert.equal(result.code, 0, `${message} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(result.json && typeof result.json === "object", `${message} returned no JSON payload\nstdout:\n${result.stdout}`);
}

async function withHarness(fn: (harness: IntegrationHarness) => Promise<void>): Promise<void> {
  const port = await getFreePort();
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "psagent-integration-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempHome,
    PSAGENT_PLUGIN_ENDPOINT: `http://127.0.0.1:${port}`
  };

  const bridge = await startMockBridge(port, env);

  const harness: IntegrationHarness = {
    fixturePath: (name: string) => path.join(repoRoot, "examples", "tests", "ops", name),
    runJson: (args: string[]) => runCliJson(args, env)
  };

  try {
    await fn(harness);
  } finally {
    await bridge.stop();
    await rm(tempHome, { recursive: true, force: true });
  }
}

async function readFixture(name: string): Promise<any> {
  const source = await readFile(path.join(repoRoot, "examples", "tests", "ops", name), "utf8");
  return JSON.parse(source);
}

async function runPayload(harness: IntegrationHarness, payload: Record<string, unknown>): Promise<CliRunResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "psagent-payload-"));
  const filePath = path.join(tempDir, "ops.json");
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    return await harness.runJson(["op", "apply", "-f", filePath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("applies full planned first-class capability payload through CLI -> adapter -> /rpc", async () => {
  await withHarness(async (harness) => {
    const sessionStart = await harness.runJson(["session", "start"]);
    assertSuccess(sessionStart, "session start");

    const openDoc = await harness.runJson(["doc", "open", "./examples/tests/input.psd"]);
    assertSuccess(openDoc, "doc open");

    const payload = await readFixture("full-planned-capabilities.json");
    const opNames = (payload.ops as Array<{ op: string }>).map((item) => item.op);
    const uniqueNames = [...new Set(opNames)].sort();
    assert.deepEqual(uniqueNames, expectedPlannedOps, "fixture must enumerate every planned first-class operation");

    const apply = await harness.runJson(["op", "apply", "-f", harness.fixturePath("full-planned-capabilities.json")]);
    assertSuccess(apply, "op apply full-planned-capabilities");

    const applyJson = apply.json as any;
    assert.equal(applyJson.result.transactionId, "planned-capabilities-001");
    assert.equal(applyJson.result.applied, payload.ops.length);
    assert.equal(applyJson.result.failed ?? 0, 0);
    assert.equal((applyJson.result.failures ?? []).length, 0);
    assert.equal(Boolean(applyJson.result.aborted), false);

    const refs = applyJson.result.refs ?? {};
    assert.ok(refs.docA, "expected docA ref in apply result");
    assert.ok(refs.layerA, "expected layerA ref in apply result");
    assert.ok(refs.placedHero, "expected placedHero ref in apply result");

    const events = await harness.runJson(["events", "tail", "--count", "20"]);
    assertSuccess(events, "events tail full-planned-capabilities");
    const eventMessages = (events.json as any).events.map((event: any) => String(event.message));
    assert.ok(eventMessages.some((message: string) => message.includes("ops.apply tx=planned-capabilities-001")));
  });
});

test("applies expanded first-class capability payload for new operation families", async () => {
  await withHarness(async (harness) => {
    const sessionStart = await harness.runJson(["session", "start"]);
    assertSuccess(sessionStart, "session start");

    const openDoc = await harness.runJson(["doc", "open", "./examples/tests/input.psd"]);
    assertSuccess(openDoc, "doc open");

    const payload = await readFixture("extended-first-class-capabilities.json");
    const opNames = (payload.ops as Array<{ op: string }>).map((item) => item.op);
    const uniqueNames = [...new Set(opNames)].sort();
    assert.deepEqual(uniqueNames, expectedExtendedOps, "fixture must enumerate every newly added first-class operation");

    const apply = await harness.runJson(["op", "apply", "-f", harness.fixturePath("extended-first-class-capabilities.json")]);
    assertSuccess(apply, "op apply extended-first-class-capabilities");

    const applyJson = apply.json as any;
    assert.equal(applyJson.result.transactionId, "extended-capabilities-001");
    assert.equal(applyJson.result.applied, payload.ops.length);
    assert.equal(applyJson.result.failed ?? 0, 0);
    assert.equal((applyJson.result.failures ?? []).length, 0);
    assert.equal(Boolean(applyJson.result.aborted), false);

    const refs = applyJson.result.refs ?? {};
    assert.ok(refs.docA, "expected docA ref in apply result");
    assert.ok(refs.base, "expected base ref in apply result");
    assert.ok(refs.adj, "expected adj ref in apply result");
    assert.ok(refs.pathA, "expected pathA ref in apply result");
    assert.ok(refs.splitDoc, "expected splitDoc ref in apply result");
  });
});

test("applies wave-2 prioritized capability payload across artboards/selection/vector/composite/history/text ops", async () => {
  await withHarness(async (harness) => {
    const sessionStart = await harness.runJson(["session", "start"]);
    assertSuccess(sessionStart, "session start");

    const openDoc = await harness.runJson(["doc", "open", "./examples/tests/input.psd"]);
    assertSuccess(openDoc, "doc open");

    const payload = await readFixture("wave2-priority-capabilities.json");
    const opNames = (payload.ops as Array<{ op: string }>).map((item) => item.op);
    const uniqueNames = [...new Set(opNames)].sort();
    assert.deepEqual(uniqueNames, expectedWave2Ops, "fixture must enumerate every wave-2 prioritized operation");

    const apply = await harness.runJson(["op", "apply", "-f", harness.fixturePath("wave2-priority-capabilities.json")]);
    assertSuccess(apply, "op apply wave2-priority-capabilities");

    const applyJson = apply.json as any;
    assert.equal(applyJson.result.transactionId, "wave2-priority-001");
    assert.equal(applyJson.result.applied, payload.ops.length);
    assert.equal(applyJson.result.failed ?? 0, 0);
    assert.equal((applyJson.result.failures ?? []).length, 0);
    assert.equal(Boolean(applyJson.result.aborted), false);

    const refs = applyJson.result.refs ?? {};
    assert.ok(refs.docA, "expected docA ref in apply result");
    assert.ok(refs.base, "expected base ref in apply result");
    assert.ok(refs.headline, "expected headline ref in apply result");
    assert.ok(refs.curvePath, "expected curvePath ref in apply result");
    assert.ok(refs.ab1, "expected ab1 ref in apply result");
    assert.ok(refs.snapshot1, "expected snapshot1 ref in apply result");
  });
});

test("mutating operations update layer/text state and report success", async () => {
  await withHarness(async (harness) => {
    const sessionStart = await harness.runJson(["session", "start"]);
    assertSuccess(sessionStart, "session start");

    const openDoc = await harness.runJson(["doc", "open", "./examples/tests/input.psd"]);
    assertSuccess(openDoc, "doc open");

    const apply = await harness.runJson(["op", "apply", "-f", harness.fixturePath("mutate-supported-ops.json")]);
    assertSuccess(apply, "op apply mutate-supported-ops");

    const applyJson = apply.json as any;
    assert.equal(applyJson.result.transactionId, "mutate-supported-001");
    assert.equal(applyJson.result.applied, 2);
    assert.equal((applyJson.result.failures ?? []).length, 0);

    const layerList = await harness.runJson(["layer", "list"]);
    assertSuccess(layerList, "layer list after mutate-supported-ops");
    const layerNames = (layerList.json as any).layers.map((layer: any) => layer.name).sort();
    assert.deepEqual(layerNames, ["Title"]);

    const manifest = await harness.runJson(["doc", "manifest"]);
    assertSuccess(manifest, "doc manifest after mutate-supported-ops");
    const titleLayer = (manifest.json as any).layers.find((layer: any) => layer.name === "Title");
    assert.ok(titleLayer, "Title layer should exist");
    assert.equal(titleLayer.text.content, "Integration Title");
  });
});

test("dry-run preserves state and abort-on-error stops subsequent mutations", async () => {
  await withHarness(async (harness) => {
    const sessionStart = await harness.runJson(["session", "start"]);
    assertSuccess(sessionStart, "session start");

    const openDoc = await harness.runJson(["doc", "open", "./examples/tests/input.psd"]);
    assertSuccess(openDoc, "doc open");

    const dryRunApply = await harness.runJson(["op", "apply", "-f", harness.fixturePath("dry-run-delete.json")]);
    assertSuccess(dryRunApply, "op apply dry-run-delete");

    const dryRunJson = dryRunApply.json as any;
    assert.equal(dryRunJson.result.transactionId, "dry-run-delete-001");
    assert.equal(dryRunJson.result.dryRun, true);
    assert.equal(dryRunJson.result.applied, 1);
    assert.equal((dryRunJson.result.failures ?? []).length, 0);

    const afterDryRun = await harness.runJson(["layer", "list"]);
    assertSuccess(afterDryRun, "layer list after dry-run");
    const afterDryRunNames = (afterDryRun.json as any).layers.map((layer: any) => layer.name).sort();
    assert.deepEqual(afterDryRunNames, ["Hero", "Title"]);

    const failingApply = await harness.runJson(["op", "apply", "-f", harness.fixturePath("failing-abort.json")]);
    assertSuccess(failingApply, "op apply failing-abort");

    const failingJson = failingApply.json as any;
    assert.equal(failingJson.result.transactionId, "failing-abort-001");
    assert.equal(failingJson.result.applied, 0);
    assert.equal((failingJson.result.failures ?? []).length, 1);
    assert.equal((failingJson.result.results ?? []).length, 1);

    const afterFailure = await harness.runJson(["layer", "list"]);
    assertSuccess(afterFailure, "layer list after failing-abort");
    const afterFailureNames = (afterFailure.json as any).layers.map((layer: any) => layer.name).sort();
    assert.deepEqual(afterFailureNames, ["Hero", "Title"], "abort behavior should prevent second deleteLayer from running");
  });
});

test("artboard parent targeting works and reorder/export validations are enforced", async () => {
  await withHarness(async (harness) => {
    const sessionStart = await harness.runJson(["session", "start"]);
    assertSuccess(sessionStart, "session start");

    const openDoc = await harness.runJson(["doc", "open", "./examples/tests/input.psd"]);
    assertSuccess(openDoc, "doc open");

    const successPayload = {
      transactionId: "artboard-parent-001",
      doc: { ref: "active" },
      ops: [
        { op: "createArtboard", name: "Artboard A", ref: "abA" },
        { op: "createArtboard", name: "Artboard B", ref: "abB" },
        { op: "createLayer", name: "Layer One", parentLayer: "$abA", ref: "layer1" },
        { op: "createTextLayer", name: "Title", text: "Hello", position: { x: 64, y: 128 }, artboard: "$abA", ref: "title" },
        { op: "createShapeLayer", name: "Badge", x: 24, y: 24, width: 80, height: 80, container: "$abA", ref: "badge" },
        {
          op: "createAdjustmentLayer",
          name: "Grade",
          type: "brightnessContrast",
          adjustment: { brightness: 6, contrast: 2 },
          targetParent: "$abA",
          ref: "grade"
        },
        { op: "placeAsset", name: "Placed", input: "./examples/tests/input.psd", parent: "$abA", ref: "placed" },
        { op: "reorderArtboards", target: "$abB", relativeTo: "$abA", placement: "placeBefore" },
        { op: "exportArtboards", outputDir: "./tmp/mock-artboards", format: "png" }
      ]
    } satisfies Record<string, unknown>;

    const successApply = await runPayload(harness, successPayload);
    assertSuccess(successApply, "op apply artboard-parent-001");
    const successJson = successApply.json as any;
    assert.equal(successJson.result.failed ?? 0, 0);
    assert.equal(successJson.result.applied, successPayload.ops.length);

    const refs = successJson.result.refs ?? {};
    const artboardAId = String(refs.abA);
    assert.ok(artboardAId, "expected ref for Artboard A");

    const manifest = await harness.runJson(["doc", "manifest"]);
    assertSuccess(manifest, "doc manifest after artboard-parent-001");
    const layersById = new Map((manifest.json as any).layers.map((layer: any) => [String(layer.id), layer]));
    for (const refName of ["layer1", "title", "badge", "grade", "placed"]) {
      const layerId = String(refs[refName]);
      const layer = layersById.get(layerId);
      assert.ok(layer, `expected layer for ref ${refName}`);
      assert.equal(String(layer.parentId), artboardAId, `${refName} should be parented to Artboard A`);
    }
    assert.equal(((manifest.json as any).exports ?? []).length, 2, "exportArtboards should export both artboards");

    const invalidReorderPayload = {
      transactionId: "artboard-parent-002",
      doc: { ref: "active" },
      ops: [{ op: "reorderArtboards", target: { layerName: "Artboard A" }, by: { x: 10, y: 0 } }]
    } satisfies Record<string, unknown>;
    const invalidReorder = await runPayload(harness, invalidReorderPayload);
    assertSuccess(invalidReorder, "op apply artboard-parent-002");
    const invalidReorderJson = invalidReorder.json as any;
    assert.equal((invalidReorderJson.result.failures ?? []).length, 1);
    const invalidReorderMessage = String(
      invalidReorderJson.result.failures?.[0]?.error?.message ?? invalidReorderJson.result.failures?.[0]?.message ?? ""
    );
    assert.match(invalidReorderMessage, /does not support by/u);
  });
});

test("vector-mask and content-aware-scale preflights return actionable failures", async () => {
  await withHarness(async (harness) => {
    const sessionStart = await harness.runJson(["session", "start"]);
    assertSuccess(sessionStart, "session start");

    const openDoc = await harness.runJson(["doc", "open", "./examples/tests/input.psd"]);
    assertSuccess(openDoc, "doc open");

    const maskedScaleBlocked = await runPayload(harness, {
      transactionId: "preflight-001",
      doc: { ref: "active" },
      ops: [
        { op: "createLayer", name: "Masked Base", ref: "base" },
        { op: "addLayerMask", target: "$base" },
        { op: "contentAwareScale", target: "$base", scaleX: 95, scaleY: 95 }
      ]
    });
    assertSuccess(maskedScaleBlocked, "op apply preflight-001");
    const maskedScaleBlockedJson = maskedScaleBlocked.json as any;
    assert.equal((maskedScaleBlockedJson.result.failures ?? []).length, 1);
    const maskedScaleBlockedMessage = String(
      maskedScaleBlockedJson.result.failures?.[0]?.error?.message ?? maskedScaleBlockedJson.result.failures?.[0]?.message ?? ""
    );
    assert.match(maskedScaleBlockedMessage, /has a mask/u);

    const maskedScaleAllowed = await runPayload(harness, {
      transactionId: "preflight-002",
      doc: { ref: "active" },
      ops: [
        { op: "createLayer", name: "Masked Allowed", ref: "base" },
        { op: "addLayerMask", target: "$base" },
        { op: "contentAwareScale", target: "$base", scaleX: 95, scaleY: 95, allowMaskedLayer: true }
      ]
    });
    assertSuccess(maskedScaleAllowed, "op apply preflight-002");
    const maskedScaleAllowedJson = maskedScaleAllowed.json as any;
    assert.equal(maskedScaleAllowedJson.result.failed ?? 0, 0);
    assert.equal(maskedScaleAllowedJson.result.applied, 3);

    const vectorMaskMissingPath = await runPayload(harness, {
      transactionId: "preflight-003",
      doc: { ref: "active" },
      ops: [
        { op: "createLayer", name: "Vector Missing", ref: "layerA" },
        { op: "createVectorMask", target: "$layerA", path: "Missing Path" }
      ]
    });
    assertSuccess(vectorMaskMissingPath, "op apply preflight-003");
    const vectorMaskMissingPathJson = vectorMaskMissingPath.json as any;
    assert.equal((vectorMaskMissingPathJson.result.failures ?? []).length, 1);
    const vectorMaskMissingPathMessage = String(
      vectorMaskMissingPathJson.result.failures?.[0]?.error?.message ?? vectorMaskMissingPathJson.result.failures?.[0]?.message ?? ""
    );
    assert.match(vectorMaskMissingPathMessage, /path not found|path target/u);

    const vectorMaskWithWorkPath = await runPayload(harness, {
      transactionId: "preflight-004",
      doc: { ref: "active" },
      ops: [
        { op: "makeWorkPathFromSelection", name: "Work Path", ref: "workPath" },
        { op: "createLayer", name: "Vector OK", ref: "layerB" },
        { op: "createVectorMask", target: "$layerB" }
      ]
    });
    assertSuccess(vectorMaskWithWorkPath, "op apply preflight-004");
    const vectorMaskWithWorkPathJson = vectorMaskWithWorkPath.json as any;
    assert.equal(vectorMaskWithWorkPathJson.result.failed ?? 0, 0);
    assert.equal(vectorMaskWithWorkPathJson.result.applied, 3);
  });
});

test("op help lists operation catalog and per-operation argument docs", async () => {
  const opHelp = await runCli(["op", "--help"], process.env);
  assert.equal(opHelp.code, 0, `op --help failed\nstdout:\n${opHelp.stdout}\nstderr:\n${opHelp.stderr}`);
  assert.match(opHelp.stdout, /Operation catalog \(from docs\/reference\/operation-catalog\.mdx\):/u);
  assert.match(opHelp.stdout, /\bcreateDocument\b/u);
  assert.match(opHelp.stdout, /\bbatchPlay\b/u);
  assert.match(opHelp.stdout, /Guidance: Photoshop can switch active documents between separate CLI invocations\./u);
  assert.match(opHelp.stdout, /psagent op <operation> --help/u);

  const createDocumentHelp = await runCli(["op", "createDocument", "--help"], process.env);
  assert.equal(
    createDocumentHelp.code,
    0,
    `op createDocument --help failed\nstdout:\n${createDocumentHelp.stdout}\nstderr:\n${createDocumentHelp.stderr}`
  );
  assert.match(
    createDocumentHelp.stdout,
    /Operation arguments and examples \(from docs\/reference\/operation-arguments-and-examples\.mdx\):/u
  );
  assert.match(createDocumentHelp.stdout, /Required: None/u);
  assert.match(createDocumentHelp.stdout, /Supported args: .*width/u);
  assert.match(createDocumentHelp.stdout, /Notes: .*mode.*fill/u);
  assert.match(createDocumentHelp.stdout, /Aliases: .*doc\.create/u);
  assert.match(createDocumentHelp.stdout, /"op": "createDocument"/u);

  const createTextHelp = await runCli(["op", "createTextLayer", "--help"], process.env);
  assert.equal(
    createTextHelp.code,
    0,
    `op createTextLayer --help failed\nstdout:\n${createTextHelp.stdout}\nstderr:\n${createTextHelp.stderr}`
  );
  assert.match(createTextHelp.stdout, /Notes: .*position\.y.*baseline/u);

  const saveDocumentAsHelp = await runCli(["op", "saveDocumentAs", "--help"], process.env);
  assert.equal(
    saveDocumentAsHelp.code,
    0,
    `op saveDocumentAs --help failed\nstdout:\n${saveDocumentAsHelp.stdout}\nstderr:\n${saveDocumentAsHelp.stderr}`
  );
  assert.match(saveDocumentAsHelp.stdout, /Notes: .*Use `output` for the destination path/u);

  const aliasHelp = await runCli(["op", "addLayerMask", "--help"], process.env);
  assert.equal(aliasHelp.code, 0, `op addLayerMask --help failed\nstdout:\n${aliasHelp.stdout}\nstderr:\n${aliasHelp.stderr}`);
  assert.match(aliasHelp.stdout, /Supported args: .*fromSelection/u);
  assert.match(aliasHelp.stdout, /"op": "addLayerMask"/u);
});

test("cli --version matches package.json version", async () => {
  const versionResult = await runCli(["--version"], process.env);
  assert.equal(
    versionResult.code,
    0,
    `--version failed\nstdout:\n${versionResult.stdout}\nstderr:\n${versionResult.stderr}`
  );

  const packageSource = await readFile(path.join(repoRoot, "package.json"), "utf8");
  const packageVersion = (JSON.parse(packageSource) as { version: string }).version;
  assert.equal(versionResult.stdout.trim(), packageVersion);
});

test("agent controls payload validates refs + onError continue/abort + rollbackOnError + checkpoints", async () => {
  await withHarness(async (harness) => {
    const sessionStart = await harness.runJson(["session", "start"]);
    assertSuccess(sessionStart, "session start");

    const openDoc = await harness.runJson(["doc", "open", "./examples/tests/input.psd"]);
    assertSuccess(openDoc, "doc open");

    const apply = await harness.runJson(["op", "apply", "-f", harness.fixturePath("agent-controls.json"), "--checkpoint"]);
    assertSuccess(apply, "op apply agent-controls --checkpoint");

    const applyJson = apply.json as any;
    assert.equal(applyJson.result.transactionId, "agent-controls-001");
    assert.equal(applyJson.result.applied, 2);
    assert.equal((applyJson.result.failures ?? []).length, 2);
    assert.equal(applyJson.result.rolledBack, true);
    assert.ok(applyJson.result.refs.agentLayer, "expected ref assignment for agentLayer");
    assert.equal(typeof applyJson.checkpointId, "string");

    const manifest = await harness.runJson(["doc", "manifest"]);
    assertSuccess(manifest, "doc manifest after rollback");

    const manifestLayers = (manifest.json as any).layers;
    const hasAgentLayer = manifestLayers.some((layer: any) => /Agent Ref Layer/.test(layer.name));
    assert.equal(hasAgentLayer, false, "rollback should remove agent-created layer");

    const titleLayer = manifestLayers.find((layer: any) => layer.name === "Title");
    assert.ok(titleLayer, "Title layer should exist after rollback");
    assert.equal(titleLayer.text.content, "Hello World");

    const checkpointId = applyJson.checkpointId as string;
    const restore = await harness.runJson(["checkpoint", "restore", checkpointId]);
    assertSuccess(restore, "checkpoint restore");

    const restoreJson = restore.json as any;
    assert.equal(restoreJson.checkpointId, checkpointId);
    assert.equal(restoreJson.restored, true);
  });
});
