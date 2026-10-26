import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const EDGE_PRESENTATION = Object.freeze({
  insideWidth: 340,
  outsideWidth: 300,
  heightRatio: 1.08,
  maximumHeight: 900,
  shrinkThreshold: 960,
  minimumResponsiveScale: 0.68,
  windowCornerRadius: 12,
  seamOverlap: 1.25,
});

export function normalizeEdgeFrameSample(value) {
  if (!value || typeof value !== "object") return null;
  const numbers = [value.x, value.y, value.width, value.height].map(Number);
  if (!numbers.every(Number.isFinite)) return null;
  const [x, y, width, height] = numbers;
  if (Math.abs(x) > 32_000 || Math.abs(y) > 32_000 ||
      width < 320 || width > 10_000 || height < 240 || height > 10_000) return null;
  return {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    width: Math.round(width * 10) / 10,
    height: Math.round(height * 10) / 10,
  };
}

export function normalizeEdgeLayoutSample(value) {
  if (!value || typeof value !== "object") return null;
  const keys = ["width", "height", "effectiveOutside", "hostEdgeX", "hostTopY", "scale"];
  const numbers = Object.fromEntries(keys.map((key) => [key, Number(value[key])]));
  if (!Object.values(numbers).every(Number.isFinite) ||
      numbers.width < 1 || numbers.width > 10_000 ||
      numbers.height < 1 || numbers.height > 10_000 ||
      numbers.effectiveOutside < 0 || numbers.effectiveOutside > numbers.width ||
      numbers.hostEdgeX < 0 || numbers.hostEdgeX > numbers.width ||
      numbers.hostTopY < 0 || numbers.hostTopY > numbers.height ||
      numbers.scale < 0.01 || numbers.scale > 2) return null;
  return Object.fromEntries(keys.map((key) => [key, Math.round(numbers[key] * 10) / 10]));
}

export function parseEdgeHelperLine(line) {
  try {
    const message = JSON.parse(String(line));
    if (message?.kind !== "edge-layout") return null;
    return normalizeEdgeLayoutSample(message.geometry);
  } catch {
    return null;
  }
}

export function edgeHelperPresentation(state) {
  const scale = clamp(Number(state?.preferences?.skinScale) || 1, 0.8, 1.3);
  return {
    insideWidth: Math.round(EDGE_PRESENTATION.insideWidth * scale),
    outsideWidth: Math.round(EDGE_PRESENTATION.outsideWidth * scale),
    heightRatio: Number((EDGE_PRESENTATION.heightRatio * scale).toFixed(4)),
    maximumHeight: Math.round(EDGE_PRESENTATION.maximumHeight * scale),
    shrinkThreshold: EDGE_PRESENTATION.shrinkThreshold,
    minimumResponsiveScale: EDGE_PRESENTATION.minimumResponsiveScale,
    windowCornerRadius: EDGE_PRESENTATION.windowCornerRadius,
    seamOverlap: EDGE_PRESENTATION.seamOverlap,
  };
}

export function edgeHelperArguments(
  state,
  characterPath,
  ownerName = "DeepSeek Harness",
  parentPID = process.pid,
  petPaths = null,
) {
  const presentation = edgeHelperPresentation(state);
  const args = [
    "--owner", ownerName,
    "--inside-width", String(presentation.insideWidth),
    "--outside-width", String(presentation.outsideWidth),
    "--height-ratio", String(presentation.heightRatio),
    "--maximum-height", String(presentation.maximumHeight),
    "--shrink-threshold", String(presentation.shrinkThreshold),
    "--minimum-responsive-scale", String(presentation.minimumResponsiveScale),
    "--window-corner-radius", String(presentation.windowCornerRadius),
    "--seam-overlap", String(presentation.seamOverlap),
    "--parent-pid", String(parentPID),
  ];
  if (characterPath) args.unshift("--character", characterPath);
  if (petPaths?.manifestPath && petPaths?.sheetPath) {
    args.push(
      "--pet-manifest", petPaths.manifestPath,
      "--pet-sheet", petPaths.sheetPath,
      "--pet-scale", String(clamp(Number(state?.preferences?.scale) || 1.2, 0.75, 2.25)),
    );
    if (petPaths.sequencePath) args.push("--pet-sequence", petPaths.sequencePath);
  }
  return args;
}

function helperEnvironment() {
  return Object.fromEntries([
    ["HOME", process.env.HOME],
    ["TMPDIR", process.env.TMPDIR],
    ["LANG", process.env.LANG],
    ["LC_ALL", process.env.LC_ALL],
  ].filter((entry) => typeof entry[1] === "string" && entry[1]));
}

export class EdgeHelperController {
  constructor({ executable = null, ownerName = "DeepSeek Harness", logger = null } = {}) {
    this.executable = typeof executable === "string" && executable ? executable : null;
    this.ownerName = ownerName;
    this.logger = logger;
    this.child = null;
    this.key = null;
    this.available = false;
    this.lastError = null;
    this.presentation = edgeHelperPresentation(null);
    this.latestFrame = null;
    this.latestPetState = { base: "idle", cue: null, eventID: null };
    this.petState = this.latestPetState;
    this.pendingPetCues = [];
    this.recentPetEventIDs = [];
    this.stdinBackpressured = false;
    this.petRunning = false;
    this.latestLayout = null;
    this.latestLayoutKey = null;
    this.layoutRevision = 0;
    this.layoutListeners = new Set();
  }

  async init() {
    this.available = process.platform === "darwin" && Boolean(this.executable);
    if (this.available) {
      try { await access(this.executable, constants.X_OK); }
      catch { this.available = false; }
    }
    return this.status();
  }

  status() {
    return {
      available: this.available,
      running: this.running(),
      error: this.lastError,
      presentation: this.presentation,
      nativePetRunning: this.running() && this.petRunning,
      layoutRevision: this.layoutRevision,
      layoutSubscribers: this.layoutListeners.size,
    };
  }

  running() {
    return Boolean(this.child && this.child.exitCode == null && !this.child.killed);
  }

  async sync(state, library, { allowPet = true } = {}) {
    const skin = state?.active?.companion?.skin;
    this.presentation = edgeHelperPresentation(state);
    const edgeEnabled = state?.preferences?.edgeExtensionEnabled === true &&
      state?.preferences?.skinEnabled === true && Boolean(skin?.characterImagePath);
    const petEnabled = allowPet && state?.preferences?.petEnabled === true && Boolean(state?.active?.spritesheetPath);
    const shouldRun = this.available && (edgeEnabled || petEnabled);
    if (!shouldRun) {
      this.stop();
      return this.status();
    }

    const characterPath = edgeEnabled
      ? await library.assetPath(state.active.id, skin.characterImagePath)
      : null;
    const petPaths = petEnabled ? {
      manifestPath: await library.runtimePetPath(state.active.id, state.active.companion?.activeAppearanceId),
      sheetPath: await library.assetPath(state.active.id, state.active.spritesheetPath),
      sequencePath: state.active.nativeFrameSequencePath
        ? await library.assetPath(state.active.id, state.active.nativeFrameSequencePath)
        : null,
    } : null;
    const args = edgeHelperArguments(state, characterPath, this.ownerName, process.pid, petPaths);
    const key = JSON.stringify([this.executable, ...args]);
    if (this.key === key && this.status().running) return this.status();

    this.stop();
    this.latestPetState = { base: this.petState.base, cue: null, eventID: null };
    this.lastError = null;
    const child = spawn(this.executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: helperEnvironment(),
    });
    this.child = child;
    this.key = key;
    this.petRunning = petEnabled;
    this.stdinBackpressured = false;
    this.latestLayout = null;
    this.latestLayoutKey = null;
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on("line", (line) => {
      if (this.child === child) this.receiveHelperLine(line);
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
      if (message) this.logger?.warn?.(`[openadam-companion] edge helper: ${message.slice(0, 500)}`);
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.lastError = error?.message || String(error);
      this.child = null;
      this.key = null;
      this.stdinBackpressured = false;
      output.close();
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.key = null;
      this.stdinBackpressured = false;
      output.close();
      if (code && code !== 0) this.lastError = `原生外延窗退出（${code}${signal ? `, ${signal}` : ""}）`;
    });
    this.#flushMessages();
    return this.status();
  }

  updateHostFrame(value) {
    const frame = normalizeEdgeFrameSample(value);
    if (!frame) return false;
    this.latestFrame = frame;
    this.#flushMessages();
    return true;
  }

  receiveHelperLine(line) {
    const geometry = parseEdgeHelperLine(line);
    if (!geometry) return false;
    const key = JSON.stringify(geometry);
    if (key === this.latestLayoutKey) return true;
    this.latestLayoutKey = key;
    const snapshot = { revision: ++this.layoutRevision, geometry };
    this.latestLayout = snapshot;
    for (const listener of this.layoutListeners) {
      try { listener(snapshot); } catch {}
    }
    return true;
  }

  subscribeLayout(listener) {
    if (typeof listener !== "function") return () => {};
    this.layoutListeners.add(listener);
    if (this.latestLayout) listener(this.latestLayout);
    return () => this.layoutListeners.delete(listener);
  }

  updatePetState(value) {
    if (!value || !["idle", "running", "waiting"].includes(value.base) ||
        (value.cue != null && !["failed", "review"].includes(value.cue)) ||
        (value.eventID != null && (typeof value.eventID !== "string" || value.eventID.length > 100)) ||
        (value.cue && !value.eventID)) return false;
    this.petState = { base: value.base, cue: value.cue ?? null, eventID: value.eventID ?? null };
    if (this.petState.base !== "idle") {
      this.pendingPetCues = this.pendingPetCues.filter((item) => item.cue !== "review");
    }
    if (this.petState.cue && !(this.petState.cue === "review" && this.petState.base !== "idle") &&
        !this.recentPetEventIDs.includes(this.petState.eventID)) {
      this.recentPetEventIDs.push(this.petState.eventID);
      if (this.recentPetEventIDs.length > 64) this.recentPetEventIDs.shift();
      this.pendingPetCues.push(this.petState);
      if (this.pendingPetCues.length > 16) this.pendingPetCues.shift();
    }
    this.latestPetState = { base: this.petState.base, cue: null, eventID: null };
    this.#flushMessages();
    return true;
  }

  #flushMessages() {
    const child = this.child;
    if (!child || child.exitCode != null || child.killed || !child.stdin || this.stdinBackpressured) return;
    let message = null;
    if (this.pendingPetCues.length) {
      message = { kind: "pet-state", ...this.pendingPetCues.shift() };
    } else if (this.latestPetState) {
      message = { kind: "pet-state", ...this.latestPetState };
      this.latestPetState = null;
    } else if (this.latestFrame) {
      message = { kind: "host-frame", ...this.latestFrame };
      this.latestFrame = null;
    }
    if (!message) return;
    this.stdinBackpressured = !child.stdin.write(`${JSON.stringify(message)}\n`);
    if (!this.stdinBackpressured) queueMicrotask(() => this.#flushMessages());
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.key = null;
    this.latestFrame = null;
    this.latestPetState = null;
    this.pendingPetCues = [];
    this.stdinBackpressured = false;
    this.petRunning = false;
    this.latestLayout = null;
    this.latestLayoutKey = null;
    if (child && child.exitCode == null && !child.killed) child.kill("SIGTERM");
  }
}
