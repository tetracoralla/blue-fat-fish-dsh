import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CompanionLibrary, AssetError, DEFAULT_MAX_BUNDLE_BYTES } from "./pet-library.js";
import { EdgeHelperController } from "./edge-helper.js";
import { BodyRendererController } from "./body-renderer.js";

export const name = "openadam-blue-fat-fish";
export const inject = ["webServer"];
export const config = {
  companionsRoot: null,
  maxUploadBytes: DEFAULT_MAX_BUNDLE_BYTES,
  initialBundlePath: null,
  edgeHelperExecutable: null,
  edgeHelperOwnerName: "DeepSeek Harness",
  bodyRendererExecutable: null,
};

const BUNDLED_COMPANION = fileURLToPath(new URL(
  "../dist/blue-fat-fish.companion.zip",
  import.meta.url,
));
const BUNDLED_COMPANION_ID = "studio.openadam.blue-whale-maid";
const BUNDLED_COMPANION_RELEASE = "1.6.8";

export function compareCompanionRelease(left, right) {
  const parse = (value) => {
    const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    return match ? { core: match.slice(1, 4).map(Number), prerelease: match[4] || null } : null;
  };
  const first = parse(left);
  const second = parse(right);
  if (!first || !second) return String(left || "").localeCompare(String(right || ""));
  for (let index = 0; index < 3; index += 1) {
    if (first.core[index] !== second.core[index]) return first.core[index] < second.core[index] ? -1 : 1;
  }
  if (first.prerelease === second.prerelease) return 0;
  if (first.prerelease == null) return 1;
  if (second.prerelease == null) return -1;
  return first.prerelease.localeCompare(second.prerelease);
}

const MIME = {
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function requestPath(request) {
  return new URL(request.url ?? "/", "http://local").pathname;
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new AssetError("ASSET_OVER_SIZE", "请求体超过容量上限");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  try { return JSON.parse((await readBody(request, 64_000)).toString("utf8")); }
  catch (error) {
    if (error instanceof AssetError) throw error;
    throw new AssetError("ASSET_INVALID", "请求不是有效 JSON", error);
  }
}

function failure(response, error) {
  if (error instanceof AssetError) {
    sendJson(response, 400, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  console.error("[openadam-companion] route error", error);
  sendJson(response, 500, { ok: false, error: { code: "ASSET_INVALID", message: error?.message || String(error) } });
}

export function attachEdgeLayoutStream(request, response, edgeHelper) {
  let closed = false;
  let backpressured = false;
  let pending = null;
  let unsubscribe = () => {};

  function cleanup() {
    if (closed) return;
    closed = true;
    pending = null;
    unsubscribe();
    request.removeListener?.("close", cleanup);
    response.removeListener?.("close", cleanup);
    response.removeListener?.("drain", drain);
  }

  function write(snapshot) {
    if (closed || !snapshot) return;
    if (backpressured) {
      pending = snapshot;
      return;
    }
    try {
      backpressured = !response.write(
        `id: ${snapshot.revision}\ndata: ${JSON.stringify(snapshot.geometry)}\n\n`,
      );
    } catch {
      cleanup();
    }
  }

  function drain() {
    backpressured = false;
    const next = pending;
    pending = null;
    if (next) write(next);
  }

  try {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    backpressured = !response.write(": connected\n\n");
  } catch {
    cleanup();
    return cleanup;
  }
  request.once?.("close", cleanup);
  response.once?.("close", cleanup);
  response.on?.("drain", drain);
  const dispose = edgeHelper.subscribeLayout(write);
  if (closed) dispose();
  else unsubscribe = dispose;
  return cleanup;
}

function companionsRoot(configuration) {
  if (configuration?.companionsRoot) return configuration.companionsRoot;
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "openadam-companions");
}

export function apply(context, configuration = {}) {
  const webServer = context.get("webServer");
  if (!webServer) return;
  const maximumBytes = configuration.maxUploadBytes || DEFAULT_MAX_BUNDLE_BYTES;
  const root = companionsRoot(configuration);
  const library = new CompanionLibrary(root, { maxUploadBytes: maximumBytes, logger: context.logger });
  const edgeHelper = new EdgeHelperController({
    executable: configuration.edgeHelperExecutable || null,
    ownerName: configuration.edgeHelperOwnerName || "DeepSeek Harness",
    logger: context.logger,
  });
  let requestRendererResync = () => {};
  const bodyRenderer = new BodyRendererController({
    executable: configuration.bodyRendererExecutable,
    logger: context.logger,
    onStatusChange: () => requestRendererResync(),
  });

  async function stateWithEdgeStatus({ sync = false } = {}) {
    const state = await library.state();
    let rendererStatus = bodyRenderer.status();
    if (sync) {
      rendererStatus = await bodyRenderer.sync(state, library);
      await edgeHelper.sync(state, library, { allowPet: !rendererStatus.ready });
    }
    return { ...state, bodyRenderer: bodyRenderer.status(), edgeExtension: edgeHelper.status() };
  }

  context.effect(() => {
    let disposed = false;
    let resyncQueued = false;
    requestRendererResync = () => {
      if (disposed || resyncQueued) return;
      resyncQueued = true;
      queueMicrotask(async () => {
        resyncQueued = false;
        if (disposed) return;
        try { await stateWithEdgeStatus({ sync: true }); }
        catch (error) { context.logger?.warn?.(`[openadam-companion] renderer fallback failed: ${error?.message || error}`); }
      });
    };
    Promise.all([library.init(), edgeHelper.init(), bodyRenderer.init()]).then(async () => {
      if (disposed) return;
      if (configuration.initialBundlePath && (await library.list()).length) return;
      if (!configuration.initialBundlePath) {
        const existing = await library.readMeta(BUNDLED_COMPANION_ID);
        if (existing && compareCompanionRelease(existing.companion?.release, BUNDLED_COMPANION_RELEASE) >= 0) return;
      }
      const initialBundlePath = configuration.initialBundlePath || BUNDLED_COMPANION;
      let bytes;
      try { bytes = await readFile(initialBundlePath); }
      catch (error) {
        if (!configuration.initialBundlePath && error?.code === "ENOENT") return;
        throw error;
      }
      await library.importZip(bytes);
    }).then(async () => {
      if (!disposed) await stateWithEdgeStatus({ sync: true });
    }).catch((error) => context.logger?.warn?.(`[openadam-companion] init failed: ${error?.message || error}`));
    const disposers = [];

    disposers.push(webServer.register({
      kind: "exact", path: "/api/openadam-companions/health",
      handler: async (_request, response) => sendJson(response, 200, {
        ok: true, plugin: name, format: "openadam.companion-bundle", schemaVersion: 1,
        bodyRendererContract: "openadam.body-renderer.v1",
      }),
    }));

    disposers.push(webServer.register({
      kind: "exact", path: "/api/openadam-companions",
      handler: async (_request, response) => {
        try { sendJson(response, 200, { ok: true, ...(await stateWithEdgeStatus()) }); }
        catch (error) { failure(response, error); }
      },
    }));

    disposers.push(webServer.register({
      kind: "exact", path: "/api/openadam-companions/upload",
      handler: async (request, response) => {
        try {
          if (request.method !== "POST") throw new AssetError("ASSET_INVALID", "只接受 POST 上传");
          const companion = await library.importZip(await readBody(request, maximumBytes));
          sendJson(response, 200, { ok: true, companion, ...(await stateWithEdgeStatus({ sync: true })) });
        } catch (error) { failure(response, error); }
      },
    }));

    disposers.push(webServer.register({
      kind: "exact", path: "/api/openadam-companions/preferences",
      handler: async (request, response) => {
        try {
          const preferences = request.method === "GET"
            ? await library.preferences()
            : await library.updatePreferences(await readJson(request));
          sendJson(response, 200, { ok: true, preferences, ...(await stateWithEdgeStatus({ sync: request.method !== "GET" })) });
        } catch (error) { failure(response, error); }
      },
    }));

    disposers.push(webServer.register({
      kind: "exact", path: "/api/openadam-companions/edge-frame",
      handler: async (request, response) => {
        try {
          if (request.method !== "POST") throw new AssetError("ASSET_INVALID", "窗口坐标只接受 POST");
          if (!edgeHelper.updateHostFrame(await readJson(request))) {
            throw new AssetError("ASSET_INVALID", "窗口坐标超出允许范围");
          }
          sendJson(response, 200, { ok: true });
        } catch (error) { failure(response, error); }
      },
    }));

    disposers.push(webServer.register({
      kind: "exact", path: "/api/openadam-companions/edge-layout-stream",
      handler: async (request, response) => {
        if (request.method !== "GET") {
          sendJson(response, 405, { ok: false, error: { code: "ASSET_INVALID", message: "窗口布局流只接受 GET" } });
          return;
        }
        attachEdgeLayoutStream(request, response, edgeHelper);
      },
    }));

    disposers.push(webServer.register({
      kind: "exact", path: "/api/openadam-companions/pet-state",
      handler: async (request, response) => {
        try {
          if (request.method !== "POST") throw new AssetError("ASSET_INVALID", "宠物状态只接受 POST");
          const body = await readJson(request);
          if (!edgeHelper.updatePetState(body) || !bodyRenderer.updatePetState(body)) {
            throw new AssetError("ASSET_INVALID", "宠物状态无效");
          }
          sendJson(response, 200, { ok: true });
        } catch (error) { failure(response, error); }
      },
    }));

    disposers.push(webServer.register({
      kind: "exact", path: "/api/openadam-companions/remove",
      handler: async (request, response) => {
        try {
          const body = await readJson(request);
          await library.remove(typeof body?.id === "string" ? body.id : "");
          sendJson(response, 200, { ok: true, ...(await stateWithEdgeStatus({ sync: true })) });
        } catch (error) { failure(response, error); }
      },
    }));

    disposers.push(webServer.register({
      kind: "prefix", path: "/openadam-companion-assets",
      handler: async (request, response) => {
        try {
          const relative = requestPath(request).slice("/openadam-companion-assets/".length);
          const slash = relative.indexOf("/");
          if (slash <= 0) throw new AssetError("ASSET_FILE_MISSING", "缺少组合包标识或资源路径");
          const id = decodeURIComponent(relative.slice(0, slash));
          const path = relative.slice(slash + 1).split("/").map(decodeURIComponent).join("/");
          const file = await library.assetPath(id, path);
          const metadata = await stat(file);
          if (!metadata.isFile()) throw new AssetError("ASSET_FILE_MISSING", "资源不存在");
          const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
          response.writeHead(200, {
            "content-type": MIME[extension] || "application/octet-stream",
            "content-length": metadata.size,
            "cache-control": "private, max-age=3600",
            "x-content-type-options": "nosniff",
          });
          createReadStream(file).pipe(response);
        } catch (error) {
          if (error?.code === "ENOENT") sendJson(response, 404, { ok: false, error: { code: "ASSET_FILE_MISSING", message: "资源不存在" } });
          else failure(response, error);
        }
      },
    }));

    return () => {
      disposed = true;
      requestRendererResync = () => {};
      bodyRenderer.stop({ clearFailure: true });
      edgeHelper.stop();
      for (const dispose of disposers.reverse()) dispose();
    };
  }, "openadam-companion: routes");
}
