import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "../lib/vendor/fflate.mjs";
import { AssetError, CompanionLibrary, inspectZipContainer, validateCompanionEntries } from "../lib/pet-library.js";
import {
  edgeHelperArguments,
  edgeHelperPresentation,
  normalizeEdgeFrameSample,
  normalizeEdgeLayoutSample,
  parseEdgeHelperLine,
} from "../lib/edge-helper.js";
import { attachEdgeLayoutStream, compareCompanionRelease } from "../lib/index.js";

const encode = (value) => strToU8(typeof value === "string" ? value : JSON.stringify(value));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("market bundle upgrades older Blue Fat Fish releases without downgrading newer ones", () => {
  assert.equal(compareCompanionRelease("1.6.5", "1.6.6"), -1);
  assert.equal(compareCompanionRelease("1.6.6", "1.6.6"), 0);
  assert.equal(compareCompanionRelease("1.7.0", "1.6.6"), 1);
  assert.equal(compareCompanionRelease("1.6.6-beta.1", "1.6.6"), -1);
});

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
}

function pngChunk(type, data) {
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, "ascii");
  Buffer.from(data).copy(output, 8);
  return output;
}

function apngFixture(frameCount, width, height) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frameCount, 0);
  const fctl = Buffer.alloc(26);
  return new Uint8Array(Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("acTL", actl),
    ...Array.from({ length: frameCount }, () => pngChunk("fcTL", fctl)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function fixtureEntries() {
  const sheet = pngHeader(1536, 2288);
  const pet = encode({
    id: "studio.openadam.test-companion", displayName: "测试伙伴", spritesheetPath: "spritesheet.png",
    frame: { width: 1536, height: 2288, columns: 8, rows: 11 },
    presentation: { defaultScale: 1.35, dragAnimation: "waiting", hoverAnimation: null },
    animations: {
      idle: { frames: [0, 1], fps: 8, loop: true },
      waiting: { frames: [48, 49, 50], fps: 12, loop: true },
      waving: { frames: [24, 25], fps: 10, loop: false, fallback: "idle" },
    },
  });
  const theme = encode({
    format: "openadam.shell-theme", schemaVersion: 1,
    identifier: "studio.openadam.test-companion.shell", name: "Test",
    light: palette(false), dark: palette(true),
  });
  const character = pngHeader(1024, 1536);
  const atmosphere = pngHeader(1600, 900);
  const skin = encode({
    format: "openadam.shell-skin", schemaVersion: 1,
    identifier: "studio.openadam.test-companion.atelier", name: "Test Atelier",
    presentation: { scene: "abyssal-atelier", defaultMode: "immersive", defaultScale: 1.05, motion: true },
  });
  const resources = [
    resource("codex-pet-v2", "resources/spritesheet.png", "image/png", sheet),
    resource("pet-manifest", "resources/pet.json", "application/json", pet),
    resource("shell-theme", "resources/theme.json", "application/json", theme),
    resource("shell-skin", "resources/skin.json", "application/json", skin),
    resource("shell-skin-character", "resources/character.png", "image/png", character),
    resource("shell-skin-atmosphere", "resources/atmosphere.png", "image/png", atmosphere),
  ];
  const definition = encode({
    format: "openadam.being-definition", schemaVersion: 1,
    identifier: "studio.openadam.test-companion", release: "1.0.0",
    seed: { name: "测试伙伴", englishName: "Test Companion", species: "test", description: "fixture" },
    resources,
  });
  const companion = encode({
    format: "openadam.companion-bundle", schemaVersion: 1,
    identifier: "studio.openadam.test-companion", release: "1.0.0", displayName: "测试伙伴",
    definitionPath: "definition",
    bodies: [{ id: "studio.openadam.test-companion.codex", format: "codex-pet.v2",
      spritesheetRole: "codex-pet-v2", manifestRole: "pet-manifest", hosts: ["dsh"] }],
    themes: [{ id: "studio.openadam.test-companion.shell", format: "openadam.shell-theme",
      resourceRole: "shell-theme", hosts: ["dsh"] }],
    skins: [{ id: "studio.openadam.test-companion.atelier", format: "openadam.shell-skin",
      manifestRole: "shell-skin", characterRole: "shell-skin-character",
      atmosphereRole: "shell-skin-atmosphere", hosts: ["dsh"] }],
    hosts: [{ host: "dsh", capabilities: ["pet-body", "shell-theme", "shell-skin"] }], notices: [],
  });
  return {
    "companion.json": companion,
    "definition/being-definition.json": definition,
    "definition/resources/spritesheet.png": sheet,
    "definition/resources/pet.json": pet,
    "definition/resources/theme.json": theme,
    "definition/resources/skin.json": skin,
    "definition/resources/character.png": character,
    "definition/resources/atmosphere.png": atmosphere,
  };
}

function appearanceFixtureEntries() {
  const entries = fixtureEntries();
  const outfitSheet = pngHeader(1536, 2288);
  const outfitPet = encode({
    id: "studio.openadam.test-companion", displayName: "Claude 伪装", spritesheetPath: "outfit-spritesheet.png",
    frame: { width: 1536, height: 2288, columns: 8, rows: 11 },
    presentation: { defaultScale: 1.25, dragAnimation: "waiting", hoverAnimation: null },
    animations: {
      idle: { frames: [0, 1], fps: 8, loop: true },
      waiting: { frames: [48, 49, 50], fps: 12, loop: true },
      waving: { frames: [24, 25], fps: 10, loop: false, fallback: "idle" },
    },
  });
  const outfitCharacter = pngHeader(1024, 1536);
  const outfitSkin = encode({
    format: "openadam.shell-skin", schemaVersion: 1,
    identifier: "studio.openadam.test-companion.claude-skin", name: "Claude 伪装",
    presentation: { scene: "abyssal-atelier", defaultMode: "edge", defaultScale: 1.1, motion: true },
  });
  entries["definition/resources/outfit-spritesheet.png"] = outfitSheet;
  entries["definition/resources/outfit-pet.json"] = outfitPet;
  entries["definition/resources/outfit-character.png"] = outfitCharacter;
  entries["definition/resources/outfit-skin.json"] = outfitSkin;

  const definition = JSON.parse(new TextDecoder().decode(entries["definition/being-definition.json"]));
  definition.resources.push(
    resource("claude-pet-v2", "resources/outfit-spritesheet.png", "image/png", outfitSheet),
    resource("claude-pet-manifest", "resources/outfit-pet.json", "application/json", outfitPet),
    resource("claude-shell-skin", "resources/outfit-skin.json", "application/json", outfitSkin),
    resource("claude-shell-character", "resources/outfit-character.png", "image/png", outfitCharacter),
  );
  entries["definition/being-definition.json"] = encode(definition);

  const companion = JSON.parse(new TextDecoder().decode(entries["companion.json"]));
  companion.bodies.push({
    id: "studio.openadam.test-companion.claude-body", format: "openadam.desktop-pet.v1",
    spritesheetRole: "claude-pet-v2", manifestRole: "claude-pet-manifest", hosts: ["dsh"],
  });
  companion.skins.push({
    id: "studio.openadam.test-companion.claude-skin", format: "openadam.shell-skin",
    manifestRole: "claude-shell-skin", characterRole: "claude-shell-character", hosts: ["dsh"],
  });
  companion.appearances = [
    {
      id: "default-maid", name: "深海女仆", bodyId: companion.bodies[0].id,
      skinId: companion.skins[0].id, themeId: companion.themes[0].id, default: true,
    },
    {
      id: "claude-disguise", name: "Claude 伪装", bodyId: companion.bodies[1].id,
      skinId: companion.skins[1].id, themeId: companion.themes[0].id,
    },
  ];
  entries["companion.json"] = encode(companion);
  return entries;
}

function projectionFixtureEntries() {
  const entries = fixtureEntries();
  const model = encode({
    Version: 3,
    FileReferences: {
      Moc: "model.moc3",
      Textures: ["texture-00.png"],
      Physics: "model.physics3.json",
      Motions: { Idle: [{ File: "motions/idle.motion3.json" }] },
    },
  });
  const moc = new Uint8Array([77, 79, 67, 51, 1, 2, 3, 4]);
  const texture = pngHeader(2048, 2048);
  const physics = encode({ Version: 3, Meta: {}, PhysicsSettings: [] });
  const motion = encode({ Version: 3, Meta: {}, Curves: [] });
  const assets = [
    ["live2d-model3", "resources/live2d/model.model3.json", "application/json", model],
    ["live2d-moc3", "resources/live2d/model.moc3", "application/octet-stream", moc],
    ["live2d-texture-00", "resources/live2d/texture-00.png", "image/png", texture],
    ["live2d-physics3", "resources/live2d/model.physics3.json", "application/json", physics],
    ["live2d-motion-idle", "resources/live2d/motions/idle.motion3.json", "application/json", motion],
  ];
  for (const [, path, , bytes] of assets) entries[`definition/${path}`] = bytes;
  const definition = JSON.parse(new TextDecoder().decode(entries["definition/being-definition.json"]));
  definition.resources.push(...assets.map((item) => resource(...item)));
  entries["definition/being-definition.json"] = encode(definition);
  const companion = JSON.parse(new TextDecoder().decode(entries["companion.json"]));
  companion.bodies[0].projection = {
    contract: "openadam.body-renderer.v1",
    format: "live2d.cubism.model3.v1",
    entryRole: "live2d-model3",
    assetRoles: ["live2d-moc3", "live2d-texture-00", "live2d-physics3", "live2d-motion-idle"],
  };
  entries["companion.json"] = encode(companion);
  return entries;
}

function resource(role, path, mediaType, bytes) {
  return { role, path, mediaType, byteCount: bytes.length, sha256: hash(bytes) };
}

function palette(dark) {
  return {
    canvas: dark ? "#07131F" : "#EAF7FC", surface: dark ? "#0D2132" : "#F7FCFE",
    surfaceRaised: dark ? "#143047" : "#FFFFFF", overlay: dark ? "#07131FF0" : "#EAF7FCF2",
    textPrimary: dark ? "#F1FAFF" : "#15364A", textSecondary: dark ? "#A8C8DA" : "#4A7185",
    accent: "#148FC9", border: "#B8DCEB", borderStrong: "#77B8D4", success: "#238B66",
    warning: "#B17816", danger: "#CE4C69", idle: "#7098AB", sidebar: dark ? "#0A1B2A" : "#DDF2FA",
  };
}

test("validates a data-only body, semantic theme and declarative shell skin", () => {
  const result = validateCompanionEntries(fixtureEntries());
  assert.equal(result.manifest.identifier, "studio.openadam.test-companion");
  assert.equal(result.pet.presentation.defaultScale, 1.35);
  assert.equal(result.theme.name, "Test");
  assert.equal(result.skin.presentation.defaultMode, "immersive");
  assert.equal(result.skin.naturalHeight, 1536);
});

test("binds a complete body, skin and optional theme as one appearance", async () => {
  const entries = appearanceFixtureEntries();
  const checked = validateCompanionEntries(entries);
  assert.equal(checked.appearances.length, 2);
  assert.equal(checked.defaultAppearanceId, "default-maid");
  assert.equal(checked.appearances[1].skin.identifier, "studio.openadam.test-companion.claude-skin");

  const broken = appearanceFixtureEntries();
  const brokenManifest = JSON.parse(new TextDecoder().decode(broken["companion.json"]));
  brokenManifest.appearances[1].bodyId = "studio.openadam.missing";
  broken["companion.json"] = encode(brokenManifest);
  assert.throws(() => validateCompanionEntries(broken), (error) =>
    error instanceof AssetError && error.code === "ASSET_INVALID" && /装扮资源/.test(error.message));

  const archive = Buffer.from(zipSync({ fixture: entries }, { level: 0 }));
  const root = await mkdtemp(join(tmpdir(), "openadam-companion-appearance-"));
  try {
    const library = new CompanionLibrary(root, { maxUploadBytes: 1_000_000 });
    await library.importZip(archive);
    let state = await library.state();
    assert.equal(state.preferences.appearanceId, "default-maid");
    assert.equal(state.active.companion.activeAppearanceId, "default-maid");
    assert.equal(state.active.companion.skin.identifier, "studio.openadam.test-companion.atelier");

    await library.updatePreferences({ appearanceId: "claude-disguise" });
    state = await library.state();
    assert.equal(state.preferences.appearanceId, "claude-disguise");
    assert.equal(state.active.companion.activeAppearanceId, "claude-disguise");
    assert.match(state.active.spritesheetPath, /outfit-spritesheet\.png$/);
    assert.equal(state.active.companion.skin.identifier, "studio.openadam.test-companion.claude-skin");
    assert.match(await library.assetPath(state.active.id, state.active.companion.skin.characterImagePath), /outfit-character\.png$/);
    assert.match(await library.runtimePetPath(state.active.id, "claude-disguise"), /claude-disguise\.pet\.json$/);

    await library.importZip(archive);
    state = await library.state();
    assert.equal(state.preferences.appearanceId, "claude-disguise");
    assert.equal(state.active.companion.activeAppearanceId, "claude-disguise");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps DSH logical size separate from a fractional Retina sprite atlas", () => {
  const entries = fixtureEntries();
  const sheet = pngHeader(3840, 5720);
  const pet = JSON.parse(new TextDecoder().decode(entries["definition/resources/pet.json"]));
  pet.frame = { width: 3840, height: 5720, columns: 8, rows: 11, pixelRatio: 2.5 };
  entries["definition/resources/spritesheet.png"] = sheet;
  entries["definition/resources/pet.json"] = encode(pet);
  const definition = JSON.parse(new TextDecoder().decode(entries["definition/being-definition.json"]));
  for (const item of definition.resources) {
    if (item.role === "codex-pet-v2") Object.assign(item, resource(item.role, item.path, item.mediaType, sheet));
    if (item.role === "pet-manifest") Object.assign(item, resource(item.role, item.path, item.mediaType, entries["definition/resources/pet.json"]));
  }
  entries["definition/being-definition.json"] = encode(definition);

  const result = validateCompanionEntries(entries);
  assert.equal(result.pet.frame.pixelRatio, 2.5);
  assert.equal(result.pet.frame.cellWidth, 480);
  assert.equal(result.pet.frame.logicalCellWidth, 192);
  assert.equal(result.pet.frame.logicalCellHeight, 208);
});

test("accepts an exact per-frame APNG for the native desktop renderer", () => {
  const entries = fixtureEntries();
  const sequence = apngFixture(88, 192, 208);
  entries["definition/resources/native-frames.png"] = sequence;
  const definition = JSON.parse(new TextDecoder().decode(entries["definition/being-definition.json"]));
  definition.resources.push(resource("pet-native-sequence", "resources/native-frames.png", "image/png", sequence));
  const companion = JSON.parse(new TextDecoder().decode(entries["companion.json"]));
  companion.bodies[0].nativeSequenceRole = "pet-native-sequence";
  entries["definition/being-definition.json"] = encode(definition);
  entries["companion.json"] = encode(companion);

  const result = validateCompanionEntries(entries);
  assert.equal(result.sequenceRecord.path, "definition/resources/native-frames.png");

  const wrongCount = fixtureEntries();
  const short = apngFixture(87, 192, 208);
  wrongCount["definition/resources/native-frames.png"] = short;
  const shortDefinition = JSON.parse(new TextDecoder().decode(wrongCount["definition/being-definition.json"]));
  shortDefinition.resources.push(resource("pet-native-sequence", "resources/native-frames.png", "image/png", short));
  const shortCompanion = JSON.parse(new TextDecoder().decode(wrongCount["companion.json"]));
  shortCompanion.bodies[0].nativeSequenceRole = "pet-native-sequence";
  wrongCount["definition/being-definition.json"] = encode(shortDefinition);
  wrongCount["companion.json"] = encode(shortCompanion);
  assert.throws(() => validateCompanionEntries(wrongCount), (error) =>
    error instanceof AssetError && error.code === "ASSET_BAD_FRAME");
});

test("admits a closed Live2D resource graph through the external body-renderer contract", async () => {
  const entries = projectionFixtureEntries();
  const checked = validateCompanionEntries(entries);
  assert.equal(checked.projection.contract, "openadam.body-renderer.v1");
  assert.equal(checked.projection.assets.length, 4);

  const archive = Buffer.from(zipSync({ fixture: entries }, { level: 0 }));
  const root = await mkdtemp(join(tmpdir(), "openadam-live2d-contract-"));
  try {
    const library = new CompanionLibrary(root, { maxUploadBytes: 2_000_000 });
    await library.importZip(archive);
    const state = await library.state();
    assert.equal(state.active.projection.format, "live2d.cubism.model3.v1");
    const paths = await library.bodyProjectionPaths(state.active.id);
    assert.match(paths.entryPath, /model\.model3\.json$/);
    assert.equal(paths.assetPaths.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const traversal = projectionFixtureEntries();
  const model = JSON.parse(new TextDecoder().decode(traversal["definition/resources/live2d/model.model3.json"]));
  model.FileReferences.Moc = "../model.moc3";
  traversal["definition/resources/live2d/model.model3.json"] = encode(model);
  const definition = JSON.parse(new TextDecoder().decode(traversal["definition/being-definition.json"]));
  const record = definition.resources.find((item) => item.role === "live2d-model3");
  Object.assign(record, resource(record.role, record.path, record.mediaType, traversal["definition/resources/live2d/model.model3.json"]));
  traversal["definition/being-definition.json"] = encode(definition);
  assert.throws(() => validateCompanionEntries(traversal), (error) =>
    error instanceof AssetError && error.code === "ASSET_PATH_TRAVERSAL");

  const audio = projectionFixtureEntries();
  const audioModelPath = "definition/resources/live2d/model.model3.json";
  const audioModel = JSON.parse(new TextDecoder().decode(audio[audioModelPath]));
  audioModel.FileReferences.Motions.Idle[0].Sound = "motions/idle.wav";
  audio[audioModelPath] = encode(audioModel);
  const audioDefinition = JSON.parse(new TextDecoder().decode(audio["definition/being-definition.json"]));
  const audioRecord = audioDefinition.resources.find((item) => item.role === "live2d-model3");
  Object.assign(audioRecord, resource(audioRecord.role, audioRecord.path, audioRecord.mediaType, audio[audioModelPath]));
  audio["definition/being-definition.json"] = encode(audioDefinition);
  assert.throws(() => validateCompanionEntries(audio), (error) =>
    error instanceof AssetError && error.code === "ASSET_INVALID" && /音频/.test(error.message));
});

test("rejects undeclared data files instead of silently installing private extras", () => {
  const entries = fixtureEntries();
  entries["definition/internal-review.md"] = encode("private construction notes");
  assert.throws(() => validateCompanionEntries(entries), (error) =>
    error instanceof AssetError && error.code === "ASSET_INVALID" && /未声明文件/.test(error.message));
});

test("rejects executable files, theme injection and changed resource bytes", () => {
  const executable = fixtureEntries();
  executable["definition/resources/run.js"] = encode("alert(1)");
  assert.throws(() => validateCompanionEntries(executable), (error) => error instanceof AssetError && error.code === "ASSET_EXECUTABLE");

  const themeInjection = fixtureEntries();
  const theme = JSON.parse(new TextDecoder().decode(themeInjection["definition/resources/theme.json"]));
  theme.light.accent = "url(javascript:alert(1))";
  themeInjection["definition/resources/theme.json"] = encode(theme);
  const definition = JSON.parse(new TextDecoder().decode(themeInjection["definition/being-definition.json"]));
  const record = definition.resources.find((item) => item.role === "shell-theme");
  record.byteCount = themeInjection["definition/resources/theme.json"].length;
  record.sha256 = hash(themeInjection["definition/resources/theme.json"]);
  themeInjection["definition/being-definition.json"] = encode(definition);
  assert.throws(() => validateCompanionEntries(themeInjection), AssetError);

  const changed = fixtureEntries();
  changed["definition/resources/pet.json"][0] ^= 1;
  assert.throws(() => validateCompanionEntries(changed), (error) => error instanceof AssetError && error.code === "ASSET_HASH_MISMATCH");

  const releaseMismatch = fixtureEntries();
  const companion = JSON.parse(new TextDecoder().decode(releaseMismatch["companion.json"]));
  companion.release = "2.0.0";
  releaseMismatch["companion.json"] = encode(companion);
  assert.throws(() => validateCompanionEntries(releaseMismatch), AssetError);

  const undersizedSkin = fixtureEntries();
  undersizedSkin["definition/resources/character.png"] = pngHeader(320, 480);
  const skinDefinition = JSON.parse(new TextDecoder().decode(undersizedSkin["definition/being-definition.json"]));
  const skinRecord = skinDefinition.resources.find((item) => item.role === "shell-skin-character");
  skinRecord.byteCount = undersizedSkin["definition/resources/character.png"].length;
  skinRecord.sha256 = hash(undersizedSkin["definition/resources/character.png"]);
  undersizedSkin["definition/being-definition.json"] = encode(skinDefinition);
  assert.throws(() => validateCompanionEntries(undersizedSkin), (error) =>
    error instanceof AssetError && error.code === "ASSET_INVALID" && /角色图/.test(error.message));
});

test("checks zip metadata before decompression and installs atomically", async () => {
  const archive = Buffer.from(zipSync({ "fixture": fixtureEntries() }, { level: 0 }));
  const inspection = inspectZipContainer(archive, 1_000_000);
  assert.ok(inspection.count >= 5);
  const root = await mkdtemp(join(tmpdir(), "openadam-blue-fat-fish-"));
  try {
    const library = new CompanionLibrary(root, { maxUploadBytes: 1_000_000 });
    await library.init();
    const imported = await library.importZip(archive);
    assert.equal(imported.id, "studio.openadam.test-companion");
    const state = await library.state();
    assert.equal(state.preferences.scale, 1.35);
    assert.equal(state.preferences.petEnabled, true);
    assert.equal(state.preferences.skinEnabled, true);
    assert.equal(state.preferences.skinScale, 1.05);
    assert.equal(state.preferences.edgeExtensionEnabled, false);
    assert.equal(state.preferences.themeEnabled, true);
    assert.equal(state.active.companion.theme.identifier, "studio.openadam.test-companion.shell");
    assert.equal(state.active.companion.skin.identifier, "studio.openadam.test-companion.atelier");
    assert.match(await library.assetPath(imported.id, state.active.spritesheetPath), /spritesheet\.png$/);
    assert.match(await library.runtimePetPath(imported.id), /pet\.json$/);
    assert.match(await library.assetPath(imported.id, state.active.companion.skin.characterImagePath), /character\.png$/);
    assert.match(await library.assetPath(imported.id, state.active.companion.skin.atmosphereImagePath), /atmosphere\.png$/);
    await assert.rejects(
      library.assetPath(imported.id, "definition/being-definition.json"),
      (error) => error instanceof AssetError && error.code === "ASSET_FILE_MISSING",
    );

    await library.updatePreferences({ petEnabled: false, skinEnabled: false, scale: 1.6 });
    await library.importZip(archive);
    const updated = await library.state();
    assert.equal(updated.preferences.petEnabled, false);
    assert.equal(updated.preferences.skinEnabled, false);
    assert.equal(updated.preferences.scale, 1.6);

    await Promise.all([library.importZip(archive), library.importZip(archive)]);
    assert.equal((await library.list()).length, 1);
    assert.equal((await readdir(root)).some((name) => name.startsWith(".rollback-")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builds a bounded native edge helper launch contract", () => {
  const state = { preferences: { skinScale: 1.3 } };
  assert.deepEqual(edgeHelperPresentation(state), {
    insideWidth: 442,
    outsideWidth: 390,
    heightRatio: 1.404,
    maximumHeight: 1170,
    shrinkThreshold: 960,
    minimumResponsiveScale: 0.68,
    windowCornerRadius: 12,
    seamOverlap: 1.25,
  });
  const args = edgeHelperArguments(state, "/tmp/character.png", "DeepSeek Harness", 1234);
  assert.deepEqual(args, [
    "--character", "/tmp/character.png",
    "--owner", "DeepSeek Harness",
    "--inside-width", "442",
    "--outside-width", "390",
    "--height-ratio", "1.404",
    "--maximum-height", "1170",
    "--shrink-threshold", "960",
    "--minimum-responsive-scale", "0.68",
    "--window-corner-radius", "12",
    "--seam-overlap", "1.25",
    "--parent-pid", "1234",
  ]);
  const petArgs = edgeHelperArguments(
    { preferences: { skinScale: 1, scale: 1.2 } },
    null,
    "DeepSeek Harness",
    1234,
    { manifestPath: "/tmp/pet.json", sheetPath: "/tmp/sheet.png" },
  );
  assert.deepEqual(petArgs.slice(-6), [
    "--pet-manifest", "/tmp/pet.json",
    "--pet-sheet", "/tmp/sheet.png",
    "--pet-scale", "1.2",
  ]);
  const sequenceArgs = edgeHelperArguments(
    { preferences: { skinScale: 1, scale: 1.2 } },
    null,
    "DeepSeek Harness",
    1234,
    { manifestPath: "/tmp/pet.json", sheetPath: "/tmp/sheet.png", sequencePath: "/tmp/frames.png" },
  );
  assert.deepEqual(sequenceArgs.slice(-2), ["--pet-sequence", "/tmp/frames.png"]);
});

test("bounds and rounds renderer host-frame samples", () => {
  assert.deepEqual(normalizeEdgeFrameSample({ x: 10.04, y: -20.06, width: 1280.04, height: 820.06 }), {
    x: 10, y: -20.1, width: 1280, height: 820.1,
  });
  assert.equal(normalizeEdgeFrameSample({ x: 0, y: 0, width: 100, height: 100 }), null);
  assert.equal(normalizeEdgeFrameSample({ x: Infinity, y: 0, width: 1280, height: 820 }), null);
});

test("validates native layout samples before projecting them into the browser", () => {
  const geometry = {
    width: 640.04, height: 777.56, effectiveOutside: 300.04,
    hostEdgeX: 340.04, hostTopY: 57.56, scale: 1,
  };
  assert.deepEqual(normalizeEdgeLayoutSample(geometry), {
    width: 640, height: 777.6, effectiveOutside: 300,
    hostEdgeX: 340, hostTopY: 57.6, scale: 1,
  });
  assert.deepEqual(parseEdgeHelperLine(JSON.stringify({ kind: "edge-layout", geometry })),
    normalizeEdgeLayoutSample(geometry));
  assert.equal(parseEdgeHelperLine("ordinary helper log"), null);
  assert.equal(normalizeEdgeLayoutSample({ ...geometry, hostEdgeX: 700 }), null);
});

test("layout stream coalesces backpressure to the newest native geometry", () => {
  const request = new EventEmitter();
  request.method = "GET";
  const response = new EventEmitter();
  const writes = [];
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
  response.write = (value) => {
    writes.push(value);
    return writes.length !== 2;
  };
  let listener = null;
  let unsubscribed = false;
  const edgeHelper = {
    subscribeLayout(value) {
      listener = value;
      value({ revision: 1, geometry: { width: 640 } });
      return () => { unsubscribed = true; };
    },
  };

  attachEdgeLayoutStream(request, response, edgeHelper);
  listener({ revision: 2, geometry: { width: 620 } });
  listener({ revision: 3, geometry: { width: 600 } });
  response.emit("drain");

  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/event-stream/);
  assert.equal(writes.some((value) => value.includes("id: 2")), false);
  assert.equal(writes.some((value) => value.includes("id: 3")), true);
  request.emit("close");
  assert.equal(unsubscribed, true);
});
