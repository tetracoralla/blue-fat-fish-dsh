import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { BODY_RENDERER_CONTRACT } from "./pet-library.js";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function rendererEnvironment() {
  return Object.fromEntries([
    ["HOME", process.env.HOME],
    ["TMPDIR", process.env.TMPDIR],
    ["LANG", process.env.LANG],
    ["LC_ALL", process.env.LC_ALL],
  ].filter((entry) => typeof entry[1] === "string" && entry[1]));
}

export function bodyRendererArguments(state, projection, parentPID = process.pid) {
  if (!projection || projection.contract !== BODY_RENDERER_CONTRACT ||
      projection.format !== "live2d.cubism.model3.v1" || !projection.entryPath) return null;
  return [
    "--contract", BODY_RENDERER_CONTRACT,
    "--format", projection.format,
    "--entry", projection.entryPath,
    "--scale", String(clamp(Number(state?.preferences?.scale) || 1.2, 0.75, 2.25)),
    "--parent-pid", String(parentPID),
  ];
}

export function parseBodyRendererLine(line, expectedFormat = "live2d.cubism.model3.v1") {
  try {
    const value = JSON.parse(String(line));
    if (value?.kind !== "ready" || value.contract !== BODY_RENDERER_CONTRACT || value.format !== expectedFormat) return null;
    return { contract: value.contract, format: value.format };
  } catch { return null; }
}

export class BodyRendererController {
  constructor({ executable = null, logger = null, handshakeMilliseconds = 5_000, onStatusChange = null, platform = process.platform } = {}) {
    this.executable = typeof executable === "string" && executable ? executable : null;
    this.logger = logger;
    this.handshakeMilliseconds = handshakeMilliseconds;
    this.onStatusChange = typeof onStatusChange === "function" ? onStatusChange : () => {};
    this.platform = platform;
    this.available = false;
    this.child = null;
    this.key = null;
    this.failedKey = null;
    this.ready = false;
    this.format = null;
    this.lastError = null;
    this.handshakeTimer = null;
    this.latestState = { base: "idle", cue: null, eventID: null };
    this.pendingCues = [];
    this.recentEventIDs = [];
    this.stdinBackpressured = false;
  }

  async init() {
    this.available = this.platform === "darwin" && Boolean(this.executable);
    if (this.available) {
      try { await access(this.executable, constants.X_OK); }
      catch { this.available = false; }
    }
    return this.status();
  }

  running() {
    return Boolean(this.child && this.child.exitCode == null && !this.child.killed);
  }

  status() {
    return {
      available: this.available,
      selected: Boolean(this.key),
      running: this.running(),
      ready: this.ready,
      format: this.format,
      contract: BODY_RENDERER_CONTRACT,
      error: this.lastError,
    };
  }

  async sync(state, library) {
    const wantsProjection = this.available && state?.preferences?.petEnabled === true && Boolean(state?.active?.projection);
    if (!wantsProjection) {
      this.stop({ clearFailure: true });
      return this.status();
    }
    const projection = await library.bodyProjectionPaths(
      state.active.id,
      state.active.companion?.activeAppearanceId,
    );
    const args = bodyRendererArguments(state, projection);
    if (!args) {
      this.stop({ clearFailure: true });
      return this.status();
    }
    const key = JSON.stringify([this.executable, ...args]);
    if (this.key === key && this.running()) return this.status();
    if (this.failedKey === key) return this.status();

    this.stop();
    this.key = key;
    this.format = projection.format;
    this.ready = false;
    this.lastError = null;
    this.latestState = { base: this.latestState?.base || "idle", cue: null, eventID: null };
    const child = spawn(this.executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: rendererEnvironment(),
    });
    this.child = child;
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.child !== child || this.ready) return;
      output = (output + String(chunk)).slice(-16_384);
      const lines = output.split(/\r?\n/);
      output = lines.pop() || "";
      if (!lines.some((line) => parseBodyRendererLine(line, projection.format))) return;
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.ready = true;
      this.#flushMessages();
      this.onStatusChange();
    });
    child.stdin.on("error", () => {});
    child.stdin.on("drain", () => {
      if (this.child !== child) return;
      this.stdinBackpressured = false;
      this.#flushMessages();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) this.logger?.warn?.(`[openadam-companion] body renderer: ${message.slice(0, 500)}`);
    });
    child.once("error", (error) => this.#failed(child, error?.message || String(error)));
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.#failed(child, `身体渲染器退出（${code ?? "?"}${signal ? `, ${signal}` : ""}）`);
    });
    this.handshakeTimer = setTimeout(() => {
      if (this.child === child && !this.ready) {
        this.#failed(child, "身体渲染器握手超时");
        if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
      }
    }, this.handshakeMilliseconds);
    this.handshakeTimer.unref?.();
    return this.status();
  }

  updatePetState(value) {
    if (!value || !["idle", "running", "waiting"].includes(value.base) ||
        (value.cue != null && !["failed", "review"].includes(value.cue)) ||
        (value.eventID != null && (typeof value.eventID !== "string" || value.eventID.length > 100)) ||
        (value.cue && !value.eventID)) return false;
    const state = { base: value.base, cue: value.cue ?? null, eventID: value.eventID ?? null };
    if (state.base !== "idle") this.pendingCues = this.pendingCues.filter((item) => item.cue !== "review");
    if (state.cue && !(state.cue === "review" && state.base !== "idle") && !this.recentEventIDs.includes(state.eventID)) {
      this.recentEventIDs.push(state.eventID);
      if (this.recentEventIDs.length > 64) this.recentEventIDs.shift();
      this.pendingCues.push(state);
      if (this.pendingCues.length > 16) this.pendingCues.shift();
    }
    this.latestState = { base: state.base, cue: null, eventID: null };
    this.#flushMessages();
    return true;
  }

  #flushMessages() {
    const child = this.child;
    if (!this.ready || !child || child.exitCode != null || child.killed || !child.stdin || this.stdinBackpressured) return;
    const state = this.pendingCues.length ? this.pendingCues.shift() : this.latestState;
    if (!state) return;
    if (state === this.latestState) this.latestState = null;
    this.stdinBackpressured = !child.stdin.write(`${JSON.stringify({ kind: "pet-state", ...state })}\n`);
    if (!this.stdinBackpressured) queueMicrotask(() => this.#flushMessages());
  }

  #failed(child, message) {
    if (this.child !== child) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.failedKey = this.key;
    this.child = null;
    this.key = null;
    this.ready = false;
    this.stdinBackpressured = false;
    this.lastError = message;
    this.onStatusChange();
  }

  stop({ clearFailure = false } = {}) {
    const child = this.child;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.child = null;
    this.key = null;
    this.ready = false;
    this.format = null;
    this.stdinBackpressured = false;
    this.pendingCues = [];
    if (clearFailure) {
      this.failedKey = null;
      this.lastError = null;
    }
    if (child && child.exitCode == null && !child.killed) child.kill("SIGTERM");
  }
}
