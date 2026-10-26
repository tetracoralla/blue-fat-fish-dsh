#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { auditCompanionPayload, auditPublicText } from "./public_payload.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist/blue-fat-fish.companion.zip");
const expectedBundleSHA256 = "5741e6ea29dd9e46e01f6107b8e8b5d41384fd20a49cc745bb46c8e606cdaac9";
const forbiddenPaths = [
  /^package\/(?:\.local|test|native|marketplace|release-profile\.json|script)(?:\/|$)/,
  /^package\/dist\/DSHEdgeCompanion\.app(?:\/|$)/,
  /(?:^|\/)(?:AGENTS|WORKING|PROVENANCE)\.md$/i,
  /(?:^|\/)\.DS_Store$/,
];
const forbiddenText = [
  "/Users/", "/Volumes/", "/private/var/", "/var/folders/", "/tmp/",
  ".local/", "WORKING.md", "AGENTS.md",
];
const personalEmailPattern = /[A-Z0-9._%+-]+@(?:gmail|outlook|hotmail|icloud|qq|163|126)\.[A-Z]{2,}/i;
const textExtensions = new Set([".js", ".mjs", ".json", ".md", ".yml", ".yaml"]);
const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedPackageName = "@openadam/blue-fat-fish";

function fail(message) {
  process.stderr.write(`market package audit failed: ${message}\n`);
  process.exitCode = 1;
}

const bundleBytes = await readFile(bundle).catch(() => null);
const bundleInfo = await stat(bundle).catch(() => null);
const bundleSHA256 = bundleBytes ? createHash("sha256").update(bundleBytes).digest("hex") : null;
if (!bundleInfo?.isFile()) fail("bundled Blue Fat Fish companion is missing");
if (bundleInfo && (bundleInfo.size < 1 || bundleInfo.size > 96_000_000)) fail("bundled companion size is invalid");
if (bundleSHA256 !== expectedBundleSHA256) fail(`bundled companion digest changed: ${bundleSHA256}`);
if (bundleBytes) {
  try { auditCompanionPayload(bundleBytes); }
  catch (error) { fail(error.message); }
}
if (packageManifest.name !== expectedPackageName) fail(`unexpected market package name: ${packageManifest.name}`);
if (packageManifest.license !== "Apache-2.0") fail("adapter license is not Apache-2.0");
if (packageManifest.private === true) fail("package is still marked private");
if (packageManifest.publishConfig?.access !== "public") fail("scoped package does not declare public npm access");
if (packageManifest.publishConfig?.registry !== "https://registry.npmjs.org/") {
  fail("market package is not pinned to the official npm publishing registry");
}
if (packageManifest.scripts?.["build:native"]) fail("market package still advertises a native build route");
if (typeof packageManifest.author !== "string" || packageManifest.author !== "OpenAdam") {
  fail("package author must be the public project identity only");
}
if (packageManifest.author?.email || packageManifest.bugs?.email) fail("package exposes a personal support email");

const dryRun = spawnSync("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, npm_config_update_notifier: "false" },
});
if (dryRun.status !== 0) {
  fail(`npm pack dry-run failed: ${dryRun.stderr.trim()}`);
  process.exit();
}

let report;
try { report = JSON.parse(dryRun.stdout)[0]; }
catch { fail("npm pack dry-run did not return JSON"); process.exit(); }
const names = report.files.map((entry) => entry.path);
const expectedPaths = ["package.json", ...packageManifest.files].sort();
if (JSON.stringify([...names].sort()) !== JSON.stringify(expectedPaths)) {
  fail("npm payload differs from the explicit file allowlist");
}
if (!names.includes("dist/blue-fat-fish.companion.zip")) fail("market package omits Blue Fat Fish");
if (!names.includes("LICENSE")) fail("market package omits the adapter license");
if (!names.includes("THIRD_PARTY_NOTICES.md")) fail("market package omits bundle licensing notice");
if (names.some((name) => name.startsWith("dist/DSHEdgeCompanion.app/") || name.startsWith("native/"))) {
  fail("market package includes a native macOS payload");
}
for (const name of names) {
  const packaged = `package/${name}`;
  if (forbiddenPaths.some((pattern) => pattern.test(packaged))) fail(`private/development path included: ${name}`);
  const absolute = resolve(root, name);
  if (absolute !== root && !absolute.startsWith(root + sep)) fail(`path escaped package root: ${name}`);
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (name !== "LICENSE" && !textExtensions.has(extension)) continue;
  const text = await readFile(absolute, "utf8");
  try { auditPublicText(name, Buffer.from(text)); }
  catch (error) { fail(error.message); }
  for (const fragment of forbiddenText) {
    if (text.includes(fragment)) fail(`private text fragment ${JSON.stringify(fragment)} included by ${name}`);
  }
  if (personalEmailPattern.test(text)) fail(`personal email address included by ${name}`);
}

if (!process.exitCode) {
  process.stdout.write(JSON.stringify({
    ok: true,
    name: report.name,
    version: report.version,
    fileCount: names.length,
    packedBytes: report.size,
    unpackedBytes: report.unpackedSize,
    bundleBytes: bundleInfo.size,
    bundleSHA256,
    paths: names,
  }, null, 2) + "\n");
}
