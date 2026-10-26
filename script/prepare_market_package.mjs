#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "../lib/vendor/fflate.mjs";
import {
  DEFAULT_MAX_BUNDLE_BYTES,
  inspectZipContainer,
  validateCompanionEntries,
} from "../lib/pet-library.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedSHA256 = "5741e6ea29dd9e46e01f6107b8e8b5d41384fd20a49cc745bb46c8e606cdaac9";
const defaultSource = resolve(root, "dist/blue-fat-fish.companion.zip");
const source = resolve(process.env.OPENADAM_BLUE_FAT_FISH_BUNDLE || defaultSource);
const destination = resolve(root, "dist/blue-fat-fish.companion.zip");
const bytes = await readFile(source);
const sha256 = createHash("sha256").update(bytes).digest("hex");

if (sha256 !== expectedSHA256) {
  throw new Error(`Blue Fat Fish bundle digest changed: ${sha256}`);
}
inspectZipContainer(bytes, DEFAULT_MAX_BUNDLE_BYTES);
const validated = validateCompanionEntries(unzipSync(new Uint8Array(bytes)));
if (validated.manifest.identifier !== "studio.openadam.blue-whale-maid" ||
    validated.manifest.release !== "1.6.8") {
  throw new Error("Blue Fat Fish bundle identity or release is unexpected");
}

await mkdir(dirname(destination), { recursive: true });
if (source !== destination) await copyFile(source, destination);
process.stdout.write(JSON.stringify({
  ok: true,
  destination,
  bytes: bytes.length,
  sha256,
  identifier: validated.manifest.identifier,
  release: validated.manifest.release,
}) + "\n");
