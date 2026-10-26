import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, stat, rm, rename, chmod, open } from "node:fs/promises";
import { join, dirname, normalize, sep, extname, posix } from "node:path";
import { unzipSync, strFromU8 } from "./vendor/fflate.mjs";

export const ERR = {
  ASSET_MISSING_FIELD: "ASSET_MISSING_FIELD",
  ASSET_FILE_MISSING: "ASSET_FILE_MISSING",
  ASSET_BAD_SPRITESHEET: "ASSET_BAD_SPRITESHEET",
  ASSET_BAD_FRAME: "ASSET_BAD_FRAME",
  ASSET_BAD_ANIMATION: "ASSET_BAD_ANIMATION",
  ASSET_OVER_SIZE: "ASSET_OVER_SIZE",
  ASSET_INVALID: "ASSET_INVALID",
  ASSET_BAD_ID: "ASSET_BAD_ID",
  ASSET_PATH_TRAVERSAL: "ASSET_PATH_TRAVERSAL",
  ASSET_HASH_MISMATCH: "ASSET_HASH_MISMATCH",
  ASSET_EXECUTABLE: "ASSET_EXECUTABLE",
};

export const ID_RE = /^[a-z0-9][a-z0-9.-]{0,119}$/;
export const APPEARANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SCALE_MIN = 0.75;
export const SCALE_MAX = 2.25;
export const SKIN_SCALE_MIN = 0.8;
export const SKIN_SCALE_MAX = 1.3;
export const SKIN_MODES = new Set(["immersive", "edge", "minimal"]);
export const BODY_RENDERER_CONTRACT = "openadam.body-renderer.v1";
export const DEFAULT_MAX_BUNDLE_BYTES = 96_000_000;
const ALLOWED_EXTENSIONS = new Set([".json", ".png", ".webp", ".jpg", ".jpeg", ".md", ".txt", ".being", ".key", ".moc3"]);
const MAX_ENTRIES = 256;
const MAX_DEFINITION_RESOURCES = 128;
const MAX_PROJECTION_ASSETS = 96;
const MAX_RESOURCE_BYTES = 64_000_000;

export class AssetError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "AssetError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes, label) {
  try { return JSON.parse(strFromU8(bytes)); }
  catch (error) { throw new AssetError(ERR.ASSET_INVALID, `${label} 不是有效 JSON`, error); }
}

function validateRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 240 || value.startsWith("/") || value.startsWith("~")) {
    throw new AssetError(ERR.ASSET_PATH_TRAVERSAL, "组合包包含无效路径");
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new AssetError(ERR.ASSET_PATH_TRAVERSAL, `非法路径：${value}`);
  }
  return parts.join("/");
}

export function resolveSafe(root, id, relativePath) {
  if (!ID_RE.test(id)) throw new AssetError(ERR.ASSET_BAD_ID, "组合包标识无效");
  const safe = validateRelativePath(relativePath);
  const target = normalize(join(root, id, ...safe.split("/")));
  if (!target.startsWith(normalize(join(root, id)) + sep)) {
    throw new AssetError(ERR.ASSET_PATH_TRAVERSAL, "组合包路径逃逸");
  }
  return target;
}

function normalizeZipEntries(entries) {
  const files = Object.entries(entries).filter(([name]) => name && !name.endsWith("/"));
  if (!files.length) return {};
  const firstParts = files.map(([name]) => name.replaceAll("\\", "/").split("/")[0]);
  const common = firstParts.every((part) => part === firstParts[0]) && files.every(([name]) => name.includes("/"));
  const output = {};
  for (const [rawName, bytes] of files) {
    const normalized = rawName.replaceAll("\\", "/");
    const name = common ? normalized.slice(normalized.indexOf("/") + 1) : normalized;
    if (name) output[name] = bytes;
  }
  return output;
}

/// Inspect central-directory metadata before decompression so declared output
/// size, encrypted entries and Unix symbolic links are rejected up front.
export function inspectZipContainer(buffer, maximumBytes) {
  const bytes = Buffer.from(buffer);
  let end = -1;
  const floor = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= floor; index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new AssetError(ERR.ASSET_INVALID, "zip 缺少中央目录");
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES || directoryOffset + directorySize > end) {
    throw new AssetError(ERR.ASSET_OVER_SIZE, "zip 条目过多或目录损坏");
  }
  let cursor = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new AssetError(ERR.ASSET_INVALID, "zip 中央目录损坏");
    }
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8);
    const expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const external = bytes.readUInt32LE(cursor + 38);
    if ((flags & 1) !== 0) throw new AssetError(ERR.ASSET_INVALID, "不接受加密 zip 条目");
    if (expanded === 0xffffffff) throw new AssetError(ERR.ASSET_OVER_SIZE, "不接受 Zip64 组合包");
    total += expanded;
    if (total > maximumBytes) throw new AssetError(ERR.ASSET_OVER_SIZE, "组合包解压后超过容量上限");
    const platform = madeBy >> 8;
    const mode = external >>> 16;
    if (platform === 3 && (mode & 0o170000) === 0o120000) {
      throw new AssetError(ERR.ASSET_PATH_TRAVERSAL, "组合包不能包含符号链接");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== directoryOffset + directorySize) throw new AssetError(ERR.ASSET_INVALID, "zip 中央目录长度不一致");
  return { count, expandedBytes: total };
}

function checkedEntry(entries, path, maximumBytes = 16_000_000) {
  const safe = validateRelativePath(path);
  const bytes = entries[safe];
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > maximumBytes) {
    throw new AssetError(ERR.ASSET_FILE_MISSING, `组合包缺少有效文件：${safe}`);
  }
  return bytes;
}

function verifyRecord(entries, record, maximumBytes = 16_000_000) {
  if (!record || typeof record !== "object") throw new AssetError(ERR.ASSET_MISSING_FIELD, "组合包文件记录缺失");
  const bytes = checkedEntry(entries, record.path, maximumBytes);
  if (record.byteCount !== bytes.length || typeof record.sha256 !== "string" || digest(bytes) !== record.sha256) {
    throw new AssetError(ERR.ASSET_HASH_MISMATCH, `组合包文件校验失败：${record.path}`);
  }
  return bytes;
}

function pngSize(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function pngAnimationInfo(bytes) {
  const buffer = Buffer.from(bytes);
  const size = pngSize(buffer);
  if (!size) return null;
  let cursor = 8;
  let declaredFrames = null;
  let frameControls = 0;
  while (cursor + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(cursor);
    const data = cursor + 8;
    const next = data + length + 4;
    if (next > buffer.length) return null;
    const type = buffer.toString("ascii", cursor + 4, cursor + 8);
    if (type === "acTL") {
      if (length !== 8) return null;
      declaredFrames = buffer.readUInt32BE(data);
    } else if (type === "fcTL") {
      if (length !== 26) return null;
      frameControls += 1;
    } else if (type === "IEND") {
      break;
    }
    cursor = next;
  }
  if (!Number.isInteger(declaredFrames) || declaredFrames < 1 || declaredFrames !== frameControls) return null;
  return { ...size, frameCount: declaredFrames };
}

function webpSize(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const type = buffer.toString("ascii", 12, 16);
  if (type === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (type === "VP8L") {
    const b0 = buffer[21], b1 = buffer[22], b2 = buffer[23], b3 = buffer[24];
    return { width: 1 + (b0 | ((b1 & 0x3f) << 8)), height: 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) };
  }
  if (type === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  return null;
}

async function readImageHeader(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(64);
    const [{ bytesRead }, metadata] = await Promise.all([handle.read(header, 0, header.length, 0), handle.stat()]);
    if (!metadata.isFile()) throw new AssetError(ERR.ASSET_FILE_MISSING, "显示资源不存在");
    return { bytes: header.subarray(0, bytesRead), byteCount: metadata.size };
  } finally {
    await handle.close();
  }
}

async function readPngAnimation(path, maximumBytes = MAX_RESOURCE_BYTES) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new AssetError(ERR.ASSET_FILE_MISSING, "原生逐帧资源不存在或过大");
  }
  return { bytes: await readFile(path), byteCount: metadata.size };
}

function validateTheme(theme, expectedId) {
  if (!theme || theme.format !== "openadam.shell-theme" || theme.schemaVersion !== 1 || theme.identifier !== expectedId) {
    throw new AssetError(ERR.ASSET_INVALID, "Shell 主题格式或标识无效");
  }
  const color = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
  const keys = ["canvas", "surface", "surfaceRaised", "overlay", "textPrimary", "textSecondary", "accent", "border", "borderStrong", "success", "warning", "danger", "idle", "sidebar"];
  for (const mode of ["light", "dark"]) {
    if (!theme[mode] || !keys.every((key) => color.test(theme[mode][key]))) {
      throw new AssetError(ERR.ASSET_INVALID, "Shell 主题只接受完整的十六进制语义色板");
    }
  }
  return theme;
}

function validateSkin(skin, imageBytes, expectedId) {
  const size = pngSize(imageBytes) || webpSize(imageBytes);
  if (!skin || skin.format !== "openadam.shell-skin" || skin.schemaVersion !== 1 ||
      skin.identifier !== expectedId || typeof skin.name !== "string" || !skin.name || !size) {
    throw new AssetError(ERR.ASSET_INVALID, "Shell 皮肤格式、标识或角色图无效");
  }
  if (size.width < 768 || size.height < 1024 || size.width > 4096 || size.height > 4096) {
    throw new AssetError(ERR.ASSET_INVALID, "Shell 皮肤角色图需在 768×1024 至 4096×4096 之间");
  }
  const presentation = skin.presentation || {};
  const defaultMode = presentation.defaultMode || "immersive";
  const defaultScale = presentation.defaultScale ?? 1;
  if (!SKIN_MODES.has(defaultMode) || typeof defaultScale !== "number" || !Number.isFinite(defaultScale) ||
      defaultScale < SKIN_SCALE_MIN || defaultScale > SKIN_SCALE_MAX ||
      !["abyssal-atelier"].includes(presentation.scene || "abyssal-atelier")) {
    throw new AssetError(ERR.ASSET_INVALID, "Shell 皮肤显示偏好无效");
  }
  return {
    ...skin,
    naturalWidth: size.width,
    naturalHeight: size.height,
    presentation: {
      scene: presentation.scene || "abyssal-atelier",
      defaultMode,
      defaultScale,
      motion: presentation.motion !== false,
    },
  };
}

function validateSkinAtmosphere(imageBytes) {
  const size = pngSize(imageBytes) || webpSize(imageBytes);
  if (!size || size.width < 1024 || size.height < 512 || size.width > 4096 || size.height > 4096) {
    throw new AssetError(ERR.ASSET_INVALID, "Shell 皮肤氛围图需在 1024×512 至 4096×4096 之间");
  }
  return size;
}

function validatePet(pet, imageBytes) {
  if (!pet || typeof pet !== "object") throw new AssetError(ERR.ASSET_MISSING_FIELD, "身体清单无效");
  const frame = pet.frame;
  const size = pngSize(imageBytes) || webpSize(imageBytes);
  if (!size) throw new AssetError(ERR.ASSET_BAD_SPRITESHEET, "身体图集需要是有效 PNG 或 WebP");
  const pixelRatio = frame?.pixelRatio ?? 1;
  const cellWidth = frame?.width / frame?.columns;
  const cellHeight = frame?.height / frame?.rows;
  if (!frame || frame.width !== size.width || frame.height !== size.height ||
      !Number.isInteger(frame.columns) || !Number.isInteger(frame.rows) ||
      frame.columns < 1 || frame.rows < 1 || frame.columns * frame.rows > 256 ||
      !Number.isFinite(pixelRatio) || pixelRatio < 1 || pixelRatio > 4 ||
      !Number.isInteger(pixelRatio * 4) ||
      cellWidth / pixelRatio !== 192 || cellHeight / pixelRatio !== 208) {
    throw new AssetError(ERR.ASSET_BAD_FRAME, "身体图集的逻辑帧需为 192×208，像素倍率需为 1–4 倍且以 0.25 递增");
  }
  const maximumFrame = frame.columns * frame.rows;
  if (!pet.animations || typeof pet.animations !== "object") throw new AssetError(ERR.ASSET_BAD_ANIMATION, "身体缺少动画表");
  for (const [name, animation] of Object.entries(pet.animations)) {
    if (!/^[a-z0-9-]{1,40}$/.test(name) || !animation || !Array.isArray(animation.frames) || !animation.frames.length ||
        animation.frames.some((value) => !Number.isInteger(value) || value < 0 || value >= maximumFrame)) {
      throw new AssetError(ERR.ASSET_BAD_ANIMATION, `动画无效：${name}`);
    }
    if (animation.fps !== undefined && (!(animation.fps > 0) || animation.fps > 60)) {
      throw new AssetError(ERR.ASSET_BAD_ANIMATION, `动画帧率无效：${name}`);
    }
    if (animation.durationsMilliseconds !== undefined &&
        (!Array.isArray(animation.durationsMilliseconds) || animation.durationsMilliseconds.length !== animation.frames.length ||
         animation.durationsMilliseconds.some((value) => !Number.isInteger(value) || value < 16 || value > 10_000))) {
      throw new AssetError(ERR.ASSET_BAD_ANIMATION, `动画时长无效：${name}`);
    }
  }
  if (!pet.animations.idle) throw new AssetError(ERR.ASSET_BAD_ANIMATION, "身体缺少 idle 动画");
  const presentation = pet.presentation || {};
  const scale = presentation.defaultScale ?? 1.35;
  if (!(scale >= SCALE_MIN && scale <= SCALE_MAX) || presentation.hoverAnimation != null ||
      (presentation.dragAnimation && !pet.animations[presentation.dragAnimation])) {
    throw new AssetError(ERR.ASSET_INVALID, "身体显示偏好无效");
  }
  return {
    ...pet,
    nativeFrameSequencePath: typeof pet.nativeFrameSequencePath === "string"
      ? validateRelativePath(pet.nativeFrameSequencePath) : null,
    frame: { ...frame, pixelRatio, cellWidth, cellHeight, logicalCellWidth: 192, logicalCellHeight: 208 },
    presentation: { ...presentation, defaultScale: scale },
  };
}

function live2dModelReferences(model) {
  if (!model || model.Version !== 3 || !model.FileReferences || typeof model.FileReferences !== "object") {
    throw new AssetError(ERR.ASSET_INVALID, "Live2D Model3 入口格式无效");
  }
  const references = model.FileReferences;
  const output = [];
  const add = (value, allowedExtensions) => {
    if (value == null) return;
    if (typeof value !== "string" || !value) {
      throw new AssetError(ERR.ASSET_INVALID, "Live2D 模型包含无效文件引用");
    }
    const safe = validateRelativePath(value);
    if (!allowedExtensions.has(extname(safe).toLowerCase())) {
      throw new AssetError(ERR.ASSET_INVALID, `Live2D 模型文件类型无效：${safe}`);
    }
    output.push(safe);
  };
  add(references.Moc, new Set([".moc3"]));
  for (const value of references.Textures || []) add(value, new Set([".png", ".jpg", ".jpeg", ".webp"]));
  for (const key of ["Physics", "Pose", "DisplayInfo", "UserData"]) add(references[key], new Set([".json"]));
  for (const expression of references.Expressions || []) add(expression?.File, new Set([".json"]));
  for (const motions of Object.values(references.Motions || {})) {
    if (!Array.isArray(motions)) throw new AssetError(ERR.ASSET_INVALID, "Live2D 动作引用无效");
    for (const motion of motions) {
      add(motion?.File, new Set([".json"]));
      if (motion?.Sound != null) {
        throw new AssetError(ERR.ASSET_INVALID, "Live2D 投影暂不接收动作音频");
      }
    }
  }
  if (typeof references.Moc !== "string" || !references.Moc ||
      !Array.isArray(references.Textures) || !references.Textures.length) {
    throw new AssetError(ERR.ASSET_INVALID, "Live2D Model3 缺少模型或纹理");
  }
  return [...new Set(output)];
}

function validateBodyProjection(projection, roles, entries) {
  if (projection == null) return null;
  if (!projection || projection.contract !== BODY_RENDERER_CONTRACT ||
      projection.format !== "live2d.cubism.model3.v1" ||
      typeof projection.entryRole !== "string" ||
      !Array.isArray(projection.assetRoles) || !projection.assetRoles.length || projection.assetRoles.length > MAX_PROJECTION_ASSETS ||
      projection.assetRoles.some((role) => typeof role !== "string") ||
      new Set(projection.assetRoles).size !== projection.assetRoles.length) {
    throw new AssetError(ERR.ASSET_INVALID, "可替换身体投影契约无效");
  }
  const entryRecord = roles.get(projection.entryRole);
  const assetRecords = projection.assetRoles.map((role) => roles.get(role));
  if (!entryRecord || assetRecords.some((record) => !record) || !entryRecord.path.endsWith(".model3.json")) {
    throw new AssetError(ERR.ASSET_FILE_MISSING, "Live2D 身体投影资源不完整");
  }
  const model = parseJson(checkedEntry(entries, entryRecord.path, 1_000_000), "Live2D model3.json");
  const entryDirectory = posix.dirname(entryRecord.path);
  const referencedPaths = new Set(live2dModelReferences(model).map((path) => {
    const resolved = posix.normalize(posix.join(entryDirectory, path));
    if (resolved.startsWith("../") || resolved.startsWith("/")) {
      throw new AssetError(ERR.ASSET_PATH_TRAVERSAL, "Live2D 模型引用越出资源目录");
    }
    return resolved;
  }));
  const declaredPaths = new Set(assetRecords.map((record) => record.path));
  if (referencedPaths.size !== declaredPaths.size ||
      [...referencedPaths].some((path) => !declaredPaths.has(path))) {
    throw new AssetError(ERR.ASSET_INVALID, "Live2D 模型引用必须与声明并校验的资源完全一致");
  }
  return {
    contract: BODY_RENDERER_CONTRACT,
    format: projection.format,
    entry: {
      path: entryRecord.path,
      byteCount: entryRecord.byteCount,
      sha256: entryRecord.sha256,
    },
    assets: assetRecords.map((record) => ({
      path: record.path,
      byteCount: record.byteCount,
      sha256: record.sha256,
    })),
  };
}

function validateBodyReference(body, roles, entries, manifestId) {
  if (!body || !["codex-pet.v2", "openadam.desktop-pet.v1"].includes(body.format) ||
      !Array.isArray(body.hosts) || !body.hosts.includes("dsh")) {
    throw new AssetError(ERR.ASSET_INVALID, "组合包身体不能用于 DSH");
  }
  const sheetRecord = roles.get(body.spritesheetRole);
  const petRecord = roles.get(body.manifestRole);
  if (!sheetRecord || !petRecord) throw new AssetError(ERR.ASSET_FILE_MISSING, "DSH 身体资源不完整");
  const pet = validatePet(
    parseJson(checkedEntry(entries, petRecord.path, 1_000_000), "pet.json"),
    checkedEntry(entries, sheetRecord.path, MAX_RESOURCE_BYTES),
  );
  if (pet.id !== manifestId) throw new AssetError(ERR.ASSET_INVALID, "身体标识与组合包不一致");
  let sequenceRecord = null;
  if (body.nativeSequenceRole) {
    sequenceRecord = roles.get(body.nativeSequenceRole);
    if (!sequenceRecord) throw new AssetError(ERR.ASSET_FILE_MISSING, "DSH 原生逐帧资源缺失");
    const sequence = pngAnimationInfo(checkedEntry(entries, sequenceRecord.path, MAX_RESOURCE_BYTES));
    const expectedFrames = pet.frame.columns * pet.frame.rows;
    if (!sequence || sequence.width !== pet.frame.cellWidth || sequence.height !== pet.frame.cellHeight ||
        sequence.frameCount !== expectedFrames) {
      throw new AssetError(ERR.ASSET_BAD_FRAME, "DSH 原生逐帧资源需逐格对应完整图集");
    }
  }
  const projection = validateBodyProjection(body.projection, roles, entries);
  return { body, pet, sheetRecord, petRecord, sequenceRecord, projection };
}

function validateThemeReference(reference, roles, entries) {
  if (!reference) return null;
  if (reference.format !== "openadam.shell-theme" || !Array.isArray(reference.hosts) || !reference.hosts.includes("dsh")) {
    throw new AssetError(ERR.ASSET_INVALID, "DSH Shell 主题引用无效");
  }
  const themeRecord = roles.get(reference.resourceRole);
  if (!themeRecord) throw new AssetError(ERR.ASSET_FILE_MISSING, "DSH 主题资源缺失");
  return validateTheme(parseJson(checkedEntry(entries, themeRecord.path, 1_000_000), "Shell 主题"), reference.id);
}

function validateSkinReference(reference, roles, entries) {
  if (!reference) return { skin: null, skinCharacterRecord: null, skinAtmosphereRecord: null };
  if (reference.format !== "openadam.shell-skin" || !Array.isArray(reference.hosts) || !reference.hosts.includes("dsh")) {
    throw new AssetError(ERR.ASSET_INVALID, "DSH Shell 皮肤格式无效");
  }
  const skinManifestRecord = roles.get(reference.manifestRole);
  const skinCharacterRecord = roles.get(reference.characterRole);
  if (!skinManifestRecord || !skinCharacterRecord) throw new AssetError(ERR.ASSET_FILE_MISSING, "DSH Shell 皮肤资源不完整");
  const skin = validateSkin(
    parseJson(checkedEntry(entries, skinManifestRecord.path, 1_000_000), "Shell 皮肤"),
    checkedEntry(entries, skinCharacterRecord.path),
    reference.id,
  );
  let skinAtmosphereRecord = null;
  if (reference.atmosphereRole) {
    skinAtmosphereRecord = roles.get(reference.atmosphereRole);
    if (!skinAtmosphereRecord) throw new AssetError(ERR.ASSET_FILE_MISSING, "DSH Shell 皮肤氛围资源缺失");
    validateSkinAtmosphere(checkedEntry(entries, skinAtmosphereRecord.path));
  }
  return { skin, skinCharacterRecord, skinAtmosphereRecord };
}

function appearanceSpecifications(manifest, dshBodies, dshSkins, dshThemes) {
  if (manifest.appearances === undefined) {
    return [{
      id: "default",
      name: manifest.displayName,
      bodyId: dshBodies[0]?.id,
      skinId: dshSkins[0]?.id || null,
      themeId: dshThemes[0]?.id || null,
      default: true,
    }];
  }
  if (!Array.isArray(manifest.appearances) || !manifest.appearances.length || manifest.appearances.length > 16) {
    throw new AssetError(ERR.ASSET_INVALID, "装扮列表需包含 1–16 项");
  }
  const identifiers = new Set();
  let defaultCount = 0;
  const appearances = manifest.appearances.map((appearance) => {
    if (!appearance || !APPEARANCE_ID_RE.test(appearance.id || "") || identifiers.has(appearance.id) ||
        typeof appearance.name !== "string" || !appearance.name || appearance.name.length > 80 ||
        typeof appearance.bodyId !== "string" ||
        (appearance.skinId != null && typeof appearance.skinId !== "string") ||
        (appearance.themeId != null && typeof appearance.themeId !== "string")) {
      throw new AssetError(ERR.ASSET_INVALID, "装扮标识、名称或资源引用无效");
    }
    identifiers.add(appearance.id);
    if (appearance.default === true) defaultCount += 1;
    return {
      id: appearance.id,
      name: appearance.name,
      bodyId: appearance.bodyId,
      skinId: appearance.skinId || null,
      themeId: appearance.themeId || null,
      default: appearance.default === true,
    };
  });
  if (defaultCount > 1) throw new AssetError(ERR.ASSET_INVALID, "组合包只能指定一个默认装扮");
  if (defaultCount === 0) appearances[0].default = true;
  return appearances;
}

export function validateCompanionEntries(rawEntries) {
  const entries = normalizeZipEntries(rawEntries);
  const names = Object.keys(entries);
  if (!names.length || names.length > MAX_ENTRIES) throw new AssetError(ERR.ASSET_OVER_SIZE, "组合包为空或条目过多");
  for (const name of names) {
    validateRelativePath(name);
    if (name === "pet.json" || name.startsWith(".openadam-runtime/")) {
      throw new AssetError(ERR.ASSET_INVALID, `组合包使用了宿主保留路径：${name}`);
    }
    if (!ALLOWED_EXTENSIONS.has(extname(name).toLowerCase())) {
      throw new AssetError(ERR.ASSET_EXECUTABLE, `组合包只能携带数据文件：${name}`);
    }
  }
  const manifest = parseJson(checkedEntry(entries, "companion.json", 1_000_000), "companion.json");
  if (manifest.format !== "openadam.companion-bundle" || manifest.schemaVersion !== 1 ||
      !ID_RE.test(manifest.identifier || "") || typeof manifest.release !== "string" || !manifest.release ||
      typeof manifest.displayName !== "string" || !manifest.displayName) {
    throw new AssetError(ERR.ASSET_INVALID, "组合包清单格式或标识无效");
  }
  const definitionPath = validateRelativePath(manifest.definitionPath);
  const definitionManifestPath = `${definitionPath}/being-definition.json`;
  const definition = parseJson(checkedEntry(entries, definitionManifestPath, 1_000_000), "being-definition.json");
  if (definition.format !== "openadam.being-definition" || definition.schemaVersion !== 1 ||
      definition.identifier !== manifest.identifier || definition.release !== manifest.release ||
      !Array.isArray(definition.resources) || definition.resources.length > MAX_DEFINITION_RESOURCES) {
    throw new AssetError(ERR.ASSET_INVALID, "组合包与实例起点不一致");
  }
  const roles = new Map();
  const declaredPaths = new Set(["companion.json", definitionManifestPath]);
  for (const resource of definition.resources) {
    if (!resource || typeof resource.role !== "string" || roles.has(resource.role)) {
      throw new AssetError(ERR.ASSET_INVALID, "实例起点资源角色重复或无效");
    }
    const record = { ...resource, path: `${definitionPath}/${validateRelativePath(resource.path)}` };
    verifyRecord(entries, record, MAX_RESOURCE_BYTES);
    roles.set(resource.role, record);
    declaredPaths.add(record.path);
  }
  const declaredHosts = new Set((manifest.hosts || []).map((item) => item && item.host));
  const dshBodies = (manifest.bodies || []).filter((item) => item && Array.isArray(item.hosts) && item.hosts.includes("dsh"));
  const dshSkins = (manifest.skins || []).filter((item) => item && Array.isArray(item.hosts) && item.hosts.includes("dsh"));
  const dshThemes = (manifest.themes || []).filter((item) => item && Array.isArray(item.hosts) && item.hosts.includes("dsh"));
  if (!dshBodies.length || !declaredHosts.has("dsh")) {
    throw new AssetError(ERR.ASSET_INVALID, "组合包没有可用于 DSH 的身体");
  }
  if ([...dshBodies, ...dshSkins, ...dshThemes].some((item) => !ID_RE.test(item.id || ""))) {
    throw new AssetError(ERR.ASSET_INVALID, "DSH 身体、皮肤或主题标识无效");
  }
  const bodiesById = new Map(dshBodies.map((item) => [item.id, item]));
  const skinsById = new Map(dshSkins.map((item) => [item.id, item]));
  const themesById = new Map(dshThemes.map((item) => [item.id, item]));
  if (bodiesById.size !== dshBodies.length || skinsById.size !== dshSkins.length || themesById.size !== dshThemes.length) {
    throw new AssetError(ERR.ASSET_INVALID, "DSH 身体、皮肤或主题标识重复");
  }
  const appearances = appearanceSpecifications(manifest, dshBodies, dshSkins, dshThemes).map((appearance) => {
    const bodyReference = bodiesById.get(appearance.bodyId);
    const skinReference = appearance.skinId ? skinsById.get(appearance.skinId) : null;
    const themeReference = appearance.themeId ? themesById.get(appearance.themeId) : null;
    if (!bodyReference || (appearance.skinId && !skinReference) || (appearance.themeId && !themeReference)) {
      throw new AssetError(ERR.ASSET_INVALID, `装扮资源引用不存在：${appearance.id}`);
    }
    return {
      ...appearance,
      ...validateBodyReference(bodyReference, roles, entries, manifest.identifier),
      ...validateSkinReference(skinReference, roles, entries),
      theme: validateThemeReference(themeReference, roles, entries),
    };
  });
  const selected = appearances.find((appearance) => appearance.default) || appearances[0];
  let capsule = null;
  if (manifest.capsule) {
    verifyRecord(entries, manifest.capsule.archive, 4_000_000);
    verifyRecord(entries, manifest.capsule.recoveryKey, 4_096);
    if (!["fork-only", "restore-or-fork"].includes(manifest.capsule.policy)) {
      throw new AssetError(ERR.ASSET_INVALID, "胶囊导入策略无效");
    }
    capsule = { policy: manifest.capsule.policy, originIdentityID: manifest.capsule.originIdentityID,
                originBranchID: manifest.capsule.originBranchID };
    declaredPaths.add(validateRelativePath(manifest.capsule.archive.path));
    declaredPaths.add(validateRelativePath(manifest.capsule.recoveryKey.path));
  }
  for (const notice of manifest.notices || []) {
    verifyRecord(entries, notice, 1_000_000);
    declaredPaths.add(validateRelativePath(notice.path));
  }
  const undeclared = names.filter((name) => !declaredPaths.has(name));
  if (undeclared.length) {
    throw new AssetError(ERR.ASSET_INVALID, `组合包包含未声明文件：${undeclared[0]}`);
  }
  return {
    entries, manifest, definition, appearances, defaultAppearanceId: selected.id,
    body: selected.body, pet: selected.pet, sheetRecord: selected.sheetRecord,
    petRecord: selected.petRecord, sequenceRecord: selected.sequenceRecord,
    projection: selected.projection,
    theme: selected.theme, skin: selected.skin,
    skinCharacterRecord: selected.skinCharacterRecord,
    skinAtmosphereRecord: selected.skinAtmosphereRecord,
    capsule,
  };
}

export function projectAppearance(companion, appearanceId) {
  const appearances = companion?.companion?.appearances;
  if (!Array.isArray(appearances) || !appearances.length) return companion;
  const appearance = appearances.find((item) => item.id === appearanceId) ||
    appearances.find((item) => item.id === companion.companion.defaultAppearanceId) || appearances[0];
  return {
    ...companion,
    ...appearance.body,
    id: companion.id,
    displayName: companion.displayName,
    description: companion.description,
    assetBytes: companion.assetBytes,
    runtimePetPath: appearance.runtimePetPath,
    companion: {
      ...companion.companion,
      activeAppearanceId: appearance.id,
      skin: appearance.skin,
      theme: appearance.theme,
    },
  };
}

function normalizedAppearanceSelections(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [companionId, appearanceId] of Object.entries(value).slice(0, 64)) {
    if (ID_RE.test(companionId) && APPEARANCE_ID_RE.test(appearanceId)) output[companionId] = appearanceId;
  }
  return output;
}

function sameRuntimeBody(left, right) {
  const keys = ["id", "displayName", "description", "spritesheetPath", "nativeFrameSequencePath", "frame", "presentation", "animations", "projection"];
  return keys.every((key) => JSON.stringify(left?.[key] ?? null) === JSON.stringify(right?.[key] ?? null));
}

export class CompanionLibrary {
  constructor(root, options = {}) {
    if (!root) throw new AssetError(ERR.ASSET_INVALID, "companionsRoot 未配置");
    this.root = root;
    this.maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
    this.logger = options.logger || null;
    this.metaCache = new Map();
    this.mutations = Promise.resolve();
  }

  mutate(work) {
    const next = this.mutations.then(work, work);
    this.mutations = next.catch(() => {});
    return next;
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => {});
  }

  async importZip(buffer) {
    return this.mutate(() => this.importZipUnserialized(buffer));
  }

  async importZipUnserialized(buffer) {
    await this.init();
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (buffer.length > this.maxUploadBytes) throw new AssetError(ERR.ASSET_OVER_SIZE, "组合包上传超过容量上限");
    inspectZipContainer(buffer, this.maxUploadBytes);
    let raw;
    try { raw = unzipSync(new Uint8Array(buffer)); }
    catch (error) { throw new AssetError(ERR.ASSET_INVALID, "组合包 zip 无法解压", error); }
    let actualExpandedBytes = 0;
    for (const bytes of Object.values(raw)) {
      actualExpandedBytes += bytes?.length || 0;
      if (actualExpandedBytes > this.maxUploadBytes) {
        throw new AssetError(ERR.ASSET_OVER_SIZE, "组合包实际解压内容超过容量上限");
      }
    }
    const checked = validateCompanionEntries(raw);
    const id = checked.manifest.identifier;
    const temporaryId = `install-${randomUUID().toLowerCase()}`;
    const temporary = join(this.root, temporaryId);
    await mkdir(temporary, { recursive: false, mode: 0o700 });
    try {
      for (const [relative, bytes] of Object.entries(checked.entries)) {
        const target = resolveSafe(this.root, temporaryId, relative);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600 });
      }
      const runtimeAppearances = checked.appearances.map((appearance, index) => {
        const { companion: _ignoredCompanion, ...pet } = appearance.pet;
        const body = {
          ...pet,
          spritesheetPath: appearance.sheetRecord.path,
          nativeFrameSequencePath: appearance.sequenceRecord?.path || null,
          projection: appearance.projection,
        };
        return {
          id: appearance.id,
          name: appearance.name,
          body,
          skin: appearance.skin ? {
            ...appearance.skin,
            characterImagePath: appearance.skinCharacterRecord.path,
            atmosphereImagePath: appearance.skinAtmosphereRecord?.path || null,
          } : null,
          theme: appearance.theme,
          runtimePetPath: `.openadam-runtime/${String(index).padStart(2, "0")}-${appearance.id}.pet.json`,
        };
      });
      const defaultAppearance = runtimeAppearances.find((appearance) => appearance.id === checked.defaultAppearanceId);
      const runtimePet = {
        ...defaultAppearance.body,
        companion: {
          identifier: id,
          release: checked.manifest.release,
          displayName: checked.manifest.displayName,
          capsule: checked.capsule,
          defaultAppearanceId: defaultAppearance.id,
          appearances: runtimeAppearances,
          theme: defaultAppearance.theme,
          skin: defaultAppearance.skin,
        },
      };
      await mkdir(join(temporary, ".openadam-runtime"), { recursive: false, mode: 0o700 });
      for (const appearance of runtimeAppearances) {
        await writeFile(
          join(temporary, ...appearance.runtimePetPath.split("/")),
          JSON.stringify(appearance.body, null, 2) + "\n",
          { mode: 0o600 },
        );
      }
      await writeFile(join(temporary, "pet.json"), JSON.stringify(runtimePet, null, 2) + "\n", { mode: 0o600 });
      const final = join(this.root, id);
      const rollback = join(this.root, `.rollback-${id}`);
      let existing = await stat(final).catch(() => null);
      const pendingRollback = await stat(rollback).catch(() => null);
      if (pendingRollback && !existing) {
        await rename(rollback, final);
        existing = await stat(final);
      } else if (pendingRollback) {
        await rm(rollback, { recursive: true, force: true });
      }
      if (existing) await rename(final, rollback);
      try {
        await rename(temporary, final);
        this.metaCache.delete(id);
      }
      catch (error) {
        if (existing) {
          try { await rename(rollback, final); }
          catch (restoreError) {
            throw new AssetError(ERR.ASSET_INVALID,
              `组合包替换失败；旧版本保留在 ${rollback}`, restoreError);
          }
        }
        this.metaCache.delete(id);
        throw error;
      }
      try {
        const preferences = await this.preferences();
        await this.writePreferences({
          ...preferences,
          active: id,
          scale: existing ? preferences.scale : defaultAppearance.body.presentation.defaultScale,
          petEnabled: existing ? preferences.petEnabled : true,
          skinEnabled: existing ? preferences.skinEnabled : Boolean(defaultAppearance.skin),
          skinMode: existing ? preferences.skinMode : defaultAppearance.skin?.presentation.defaultMode || preferences.skinMode,
          skinScale: existing ? preferences.skinScale : defaultAppearance.skin?.presentation.defaultScale || preferences.skinScale,
          themeEnabled: existing ? preferences.themeEnabled : Boolean(defaultAppearance.theme),
          appearanceSelections: {
            ...preferences.appearanceSelections,
            [id]: existing && runtimeAppearances.some((appearance) => appearance.id === preferences.appearanceSelections?.[id])
              ? preferences.appearanceSelections[id]
              : defaultAppearance.id,
          },
        });
      } catch (error) {
        await rm(final, { recursive: true, force: true });
        if (existing) await rename(rollback, final);
        this.metaCache.delete(id);
        throw error;
      }
      await rm(rollback, { recursive: true, force: true });
      return this.readMeta(id);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (error instanceof AssetError) throw error;
      throw new AssetError(ERR.ASSET_INVALID, "组合包写入失败", error);
    }
  }

  async readMeta(id) {
    if (!ID_RE.test(id)) return null;
    try {
      const runtimeManifest = join(this.root, id, "pet.json");
      const runtimeMetadata = await stat(runtimeManifest);
      const cacheKey = `${runtimeMetadata.size}:${runtimeMetadata.mtimeMs}`;
      const cached = this.metaCache.get(id);
      if (cached?.key === cacheKey) return cached.value;
      const stored = JSON.parse(await readFile(runtimeManifest, "utf8"));
      const defaultImage = await readImageHeader(resolveSafe(this.root, id, stored.spritesheetPath));
      const validatedStored = validatePet(stored, defaultImage.bytes);
      const declared = Array.isArray(validatedStored.companion?.appearances)
        ? validatedStored.companion.appearances
        : [{
            id: "default",
            name: validatedStored.companion?.displayName || validatedStored.displayName || id,
            body: stored,
            skin: validatedStored.companion?.skin || null,
            theme: validatedStored.companion?.theme || null,
            runtimePetPath: "pet.json",
          }];
      if (!declared.length || declared.length > 16) throw new AssetError(ERR.ASSET_INVALID, "运行时装扮列表无效");
      const appearanceIds = new Set();
      const assetSizes = new Map();
      const appearances = [];
      for (const rawAppearance of declared) {
        if (!rawAppearance || !APPEARANCE_ID_RE.test(rawAppearance.id || "") || appearanceIds.has(rawAppearance.id) ||
            typeof rawAppearance.name !== "string" || !rawAppearance.name || !rawAppearance.body) {
          throw new AssetError(ERR.ASSET_INVALID, "运行时装扮无效");
        }
        appearanceIds.add(rawAppearance.id);
        const runtimePetPath = validateRelativePath(rawAppearance.runtimePetPath || "pet.json");
        const runtimeBody = JSON.parse(await readFile(resolveSafe(this.root, id, runtimePetPath), "utf8"));
        if (!sameRuntimeBody(rawAppearance.body, runtimeBody)) {
          throw new AssetError(ERR.ASSET_INVALID, `装扮运行时身体不一致：${rawAppearance.id}`);
        }
        const bodyImage = await readImageHeader(resolveSafe(this.root, id, runtimeBody.spritesheetPath));
        assetSizes.set(runtimeBody.spritesheetPath, bodyImage.byteCount);
        const validatedBodyWithExtras = validatePet(runtimeBody, bodyImage.bytes);
        const { companion: _ignoredCompanion, ...validatedBody } = validatedBodyWithExtras;
        let nativeFrameSequencePath = null;
        if (validatedBody.nativeFrameSequencePath) {
          const sequenceImage = await readPngAnimation(resolveSafe(this.root, id, validatedBody.nativeFrameSequencePath));
          const sequence = pngAnimationInfo(sequenceImage.bytes);
          const expectedFrames = validatedBody.frame.columns * validatedBody.frame.rows;
          if (!sequence || sequence.width !== validatedBody.frame.cellWidth || sequence.height !== validatedBody.frame.cellHeight ||
              sequence.frameCount !== expectedFrames) {
            throw new AssetError(ERR.ASSET_BAD_FRAME, "运行时原生逐帧资源无效");
          }
          nativeFrameSequencePath = validatedBody.nativeFrameSequencePath;
          assetSizes.set(nativeFrameSequencePath, sequenceImage.byteCount);
        }
        let projection = null;
        if (validatedBody.projection != null) {
          const rawProjection = validatedBody.projection;
          if (rawProjection.contract !== BODY_RENDERER_CONTRACT ||
              rawProjection.format !== "live2d.cubism.model3.v1" ||
              !rawProjection.entry || !Array.isArray(rawProjection.assets) || !rawProjection.assets.length) {
            throw new AssetError(ERR.ASSET_INVALID, "运行时身体投影契约无效");
          }
          const records = [rawProjection.entry, ...rawProjection.assets];
          const paths = new Set();
          for (const record of records) {
            const path = validateRelativePath(record?.path);
            if (paths.has(path) || !Number.isInteger(record.byteCount) || record.byteCount < 1 ||
                typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
              throw new AssetError(ERR.ASSET_INVALID, "运行时身体投影资源无效");
            }
            paths.add(path);
            const metadata = await stat(resolveSafe(this.root, id, path));
            if (!metadata.isFile() || metadata.size !== record.byteCount) {
              throw new AssetError(ERR.ASSET_FILE_MISSING, "运行时身体投影资源缺失");
            }
            assetSizes.set(path, metadata.size);
          }
          projection = {
            contract: BODY_RENDERER_CONTRACT,
            format: rawProjection.format,
            entry: { ...rawProjection.entry, path: validateRelativePath(rawProjection.entry.path) },
            assets: rawProjection.assets.map((record) => ({ ...record, path: validateRelativePath(record.path) })),
          };
        }
        let skin = null;
        if (rawAppearance.skin?.characterImagePath) {
          const characterPath = validateRelativePath(rawAppearance.skin.characterImagePath);
          const skinImage = await readImageHeader(resolveSafe(this.root, id, characterPath));
          assetSizes.set(characterPath, skinImage.byteCount);
          let atmosphereImagePath = null;
          if (rawAppearance.skin.atmosphereImagePath) {
            atmosphereImagePath = validateRelativePath(rawAppearance.skin.atmosphereImagePath);
            const atmosphereImage = await readImageHeader(resolveSafe(this.root, id, atmosphereImagePath));
            validateSkinAtmosphere(atmosphereImage.bytes);
            assetSizes.set(atmosphereImagePath, atmosphereImage.byteCount);
          }
          skin = {
            ...validateSkin(rawAppearance.skin, skinImage.bytes, rawAppearance.skin.identifier),
            characterImagePath: characterPath,
            atmosphereImagePath,
          };
        }
        const theme = rawAppearance.theme
          ? validateTheme(rawAppearance.theme, rawAppearance.theme.identifier)
          : null;
        appearances.push({
          id: rawAppearance.id,
          name: rawAppearance.name,
          body: { ...validatedBody, nativeFrameSequencePath, projection },
          skin,
          theme,
          runtimePetPath,
        });
      }
      const requestedDefault = validatedStored.companion?.defaultAppearanceId;
      const defaultAppearance = appearances.find((appearance) => appearance.id === requestedDefault) || appearances[0];
      const companion = validatedStored.companion ? {
        identifier: validatedStored.companion.identifier,
        release: validatedStored.companion.release,
        displayName: validatedStored.companion.displayName,
        capsule: validatedStored.companion.capsule || null,
        defaultAppearanceId: defaultAppearance.id,
        activeAppearanceId: defaultAppearance.id,
        appearances,
        skin: defaultAppearance.skin,
        theme: defaultAppearance.theme,
      } : null;
      const value = {
        ...defaultAppearance.body,
        id,
        displayName: defaultAppearance.body.displayName || id,
        description: defaultAppearance.body.description || "",
        nativeFrameSequencePath: defaultAppearance.body.nativeFrameSequencePath,
        runtimePetPath: defaultAppearance.runtimePetPath,
        assetBytes: [...assetSizes.values()].reduce((total, value) => total + value, 0),
        companion,
      };
      this.metaCache.set(id, { key: cacheKey, value });
      return value;
    } catch (error) {
      this.logger?.warn?.(`[openadam-companion] invalid installed companion ${id}: ${error?.message || error}`);
      return null;
    }
  }

  async list() {
    let children = [];
    try { children = await readdir(this.root); } catch { return []; }
    const result = [];
    for (const id of children) {
      if (!ID_RE.test(id)) continue;
      const meta = await this.readMeta(id);
      if (meta) result.push(meta);
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  async preferences() {
    try {
      const parsed = JSON.parse(await readFile(join(this.root, ".preferences.json"), "utf8"));
      return {
        active: typeof parsed.active === "string" ? parsed.active : null,
        scale: typeof parsed.scale === "number" && parsed.scale >= SCALE_MIN && parsed.scale <= SCALE_MAX ? parsed.scale : 1.35,
        petEnabled: parsed.petEnabled !== false,
        themeEnabled: parsed.themeEnabled !== false,
        skinEnabled: parsed.skinEnabled !== false,
        skinMode: SKIN_MODES.has(parsed.skinMode) ? parsed.skinMode : "immersive",
        skinScale: typeof parsed.skinScale === "number" && parsed.skinScale >= SKIN_SCALE_MIN && parsed.skinScale <= SKIN_SCALE_MAX ? parsed.skinScale : 1,
        edgeExtensionEnabled: parsed.edgeExtensionEnabled === true,
        appearanceSelections: normalizedAppearanceSelections(parsed.appearanceSelections),
      };
    } catch { return { active: null, scale: 1.35, petEnabled: true, themeEnabled: true, skinEnabled: true, skinMode: "immersive", skinScale: 1, edgeExtensionEnabled: false, appearanceSelections: {} }; }
  }

  async writePreferences(value) {
    await this.init();
    const next = {
      active: typeof value.active === "string" ? value.active : null,
      scale: typeof value.scale === "number" && value.scale >= SCALE_MIN && value.scale <= SCALE_MAX ? value.scale : 1.35,
      petEnabled: value.petEnabled !== false,
      themeEnabled: value.themeEnabled !== false,
      skinEnabled: value.skinEnabled !== false,
      skinMode: SKIN_MODES.has(value.skinMode) ? value.skinMode : "immersive",
      skinScale: typeof value.skinScale === "number" && value.skinScale >= SKIN_SCALE_MIN && value.skinScale <= SKIN_SCALE_MAX ? value.skinScale : 1,
      edgeExtensionEnabled: value.edgeExtensionEnabled === true,
      appearanceSelections: normalizedAppearanceSelections(value.appearanceSelections),
    };
    if (next.active && !(await this.readMeta(next.active))) throw new AssetError(ERR.ASSET_FILE_MISSING, "组合包不存在");
    const temporary = join(this.root, `.preferences-${randomUUID().toLowerCase()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, join(this.root, ".preferences.json"));
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return next;
  }

  async updatePreferences(patch) {
    return this.mutate(() => this.updatePreferencesUnserialized(patch));
  }

  async updatePreferencesUnserialized(patch) {
    const current = await this.preferences();
    const next = { ...current, appearanceSelections: { ...current.appearanceSelections } };
    if (Object.hasOwn(patch, "active")) next.active = typeof patch.active === "string" ? patch.active : null;
    if (Object.hasOwn(patch, "scale")) {
      if (typeof patch.scale !== "number" || !Number.isFinite(patch.scale) || patch.scale < SCALE_MIN || patch.scale > SCALE_MAX) {
        throw new AssetError(ERR.ASSET_INVALID, `宠物大小需在 ${SCALE_MIN}–${SCALE_MAX} 之间`);
      }
      next.scale = patch.scale;
    }
    if (Object.hasOwn(patch, "petEnabled")) next.petEnabled = patch.petEnabled === true;
    if (Object.hasOwn(patch, "themeEnabled")) next.themeEnabled = patch.themeEnabled === true;
    if (Object.hasOwn(patch, "skinEnabled")) next.skinEnabled = patch.skinEnabled === true;
    if (Object.hasOwn(patch, "edgeExtensionEnabled")) next.edgeExtensionEnabled = patch.edgeExtensionEnabled === true;
    if (Object.hasOwn(patch, "skinMode")) {
      if (!SKIN_MODES.has(patch.skinMode)) throw new AssetError(ERR.ASSET_INVALID, "Shell 皮肤布局无效");
      next.skinMode = patch.skinMode;
    }
    if (Object.hasOwn(patch, "skinScale")) {
      if (typeof patch.skinScale !== "number" || !Number.isFinite(patch.skinScale) || patch.skinScale < SKIN_SCALE_MIN || patch.skinScale > SKIN_SCALE_MAX) {
        throw new AssetError(ERR.ASSET_INVALID, `Shell 角色大小需在 ${SKIN_SCALE_MIN}–${SKIN_SCALE_MAX} 之间`);
      }
      next.skinScale = patch.skinScale;
    }
    if (Object.hasOwn(patch, "appearanceId")) {
      if (!next.active) throw new AssetError(ERR.ASSET_INVALID, "请先选择组合包再切换装扮");
      const companion = await this.readMeta(next.active);
      const appearances = companion?.companion?.appearances || [];
      if (!APPEARANCE_ID_RE.test(patch.appearanceId || "") || !appearances.some((appearance) => appearance.id === patch.appearanceId)) {
        throw new AssetError(ERR.ASSET_INVALID, "装扮不存在或不完整");
      }
      next.appearanceSelections[next.active] = patch.appearanceId;
    }
    return this.writePreferences(next);
  }

  async state() {
    const [companions, preferences] = await Promise.all([this.list(), this.preferences()]);
    const activeCompanion = companions.find((item) => item.id === preferences.active) || null;
    const active = activeCompanion
      ? projectAppearance(activeCompanion, preferences.appearanceSelections[activeCompanion.id])
      : null;
    return {
      companions,
      preferences: { ...preferences, appearanceId: active?.companion?.activeAppearanceId || null },
      active,
    };
  }

  async remove(id) {
    return this.mutate(() => this.removeUnserialized(id));
  }

  async removeUnserialized(id) {
    if (!ID_RE.test(id)) throw new AssetError(ERR.ASSET_BAD_ID, "组合包标识无效");
    const preferences = await this.preferences();
    const appearanceSelections = { ...preferences.appearanceSelections };
    delete appearanceSelections[id];
    if (preferences.active === id || Object.keys(appearanceSelections).length !== Object.keys(preferences.appearanceSelections).length) {
      await this.writePreferences({
        ...preferences,
        appearanceSelections,
        active: preferences.active === id ? null : preferences.active,
        petEnabled: preferences.active === id ? false : preferences.petEnabled,
        themeEnabled: preferences.active === id ? false : preferences.themeEnabled,
        skinEnabled: preferences.active === id ? false : preferences.skinEnabled,
      });
    }
    await rm(join(this.root, id), { recursive: true, force: true });
    this.metaCache.delete(id);
  }

  async assetPath(id, relativePath) {
    if (!ID_RE.test(id)) throw new AssetError(ERR.ASSET_BAD_ID, "组合包标识无效");
    const safe = validateRelativePath(relativePath);
    const companion = await this.readMeta(id);
    const appearances = companion?.companion?.appearances || [];
    const allowed = new Set(appearances.flatMap((appearance) => [
      appearance.body?.spritesheetPath,
      appearance.body?.nativeFrameSequencePath,
      appearance.body?.projection?.entry?.path,
      ...(appearance.body?.projection?.assets || []).map((record) => record.path),
      appearance.skin?.characterImagePath,
      appearance.skin?.atmosphereImagePath,
    ]).filter(Boolean));
    if (!companion || !allowed.has(safe)) {
      throw new AssetError(ERR.ASSET_FILE_MISSING, "只允许读取已校验的显示资源");
    }
    return resolveSafe(this.root, id, safe);
  }

  async bodyProjectionPaths(id, appearanceId = null) {
    const companion = ID_RE.test(id) ? await this.readMeta(id) : null;
    if (!companion) throw new AssetError(ERR.ASSET_FILE_MISSING, "桌面身体不存在");
    const selected = projectAppearance(companion, appearanceId);
    const projection = selected.projection;
    if (!projection) return null;
    return {
      contract: projection.contract,
      format: projection.format,
      entryPath: resolveSafe(this.root, id, projection.entry.path),
      assetPaths: projection.assets.map((record) => resolveSafe(this.root, id, record.path)),
    };
  }

  async runtimePetPath(id, appearanceId = null) {
    const companion = ID_RE.test(id) ? await this.readMeta(id) : null;
    if (!companion) {
      throw new AssetError(ERR.ASSET_FILE_MISSING, "桌面宠物清单不存在");
    }
    return resolveSafe(this.root, id, projectAppearance(companion, appearanceId).runtimePetPath || "pet.json");
  }
}
