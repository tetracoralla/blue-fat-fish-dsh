import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zipSync, unzipSync } from "../lib/vendor/fflate.mjs";
import { auditPublicText, auditCompanionPayload } from "../script/public_payload.mjs";
import { exportPublicSource } from "../script/export_public_source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const encode = (value) => new TextEncoder().encode(value);

test("public text rejects synthetic work records and private paths without echoing their contents", () => {
  for (const data of [
    ["User", "confirmed", "a synthetic test choice."].join(" "),
    "/Users/example-maintainer/private-project/",
    "/Volumes/ExampleDisk/private-project/",
    Buffer.from("/Users/example-maintainer/private-project/", "utf16le"),
    `pet_${"a".repeat(30)}`,
  ]) {
    assert.throws(() => auditPublicText("definition/README.md", data), /private content/);
  }
  assert.throws(() => auditPublicText("definition/WORKING.md", "Synthetic continuation"), /working record/);
  assert.doesNotThrow(() => auditPublicText("definition/ATTRIBUTION.md", "Example Artist, CC BY-NC-SA 4.0"));
});

test("nested companion audit rejects a declared synthetic work record", () => {
  // Use the real reviewed fixture graph, then inject one additional declared file.
  const bundle = readFileSync(join(root, "dist/blue-fat-fish.companion.zip"));
  const entries = unzipSync(new Uint8Array(bundle));
  const definition = JSON.parse(new TextDecoder().decode(entries["definition/being-definition.json"]));
  const note = encode("Synthetic maintainer continuation.");
  entries["definition/WORKING.md"] = note;
  definition.resources.push({ path: "WORKING.md", role: "personality-notes", mediaType: "text/markdown",
    byteCount: note.length, sha256: createHash("sha256").update(note).digest("hex") });
  entries["definition/being-definition.json"] = encode(JSON.stringify(definition));
  assert.throws(() => auditCompanionPayload(zipSync(entries)), /unreviewed role|working record/);
  assert.equal(auditCompanionPayload(bundle).length, 16);
});

test("npm file allowlist excludes a synthetic note inside the runtime directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "public-package-"));
  try {
    const packageJSON = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const { mkdir, copyFile } = await import("node:fs/promises");
    await mkdir(join(directory, "lib"));
    await writeFile(join(directory, "package.json"), JSON.stringify(packageJSON));
    await copyFile(join(root, "lib/index.js"), join(directory, "lib/index.js"));
    await writeFile(join(directory, "lib/WORKING.md"), "Synthetic private work record.");
    const result = spawnSync("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], {
      cwd: directory, encoding: "utf8", env: { ...process.env, npm_config_update_notifier: "false" },
    });
    assert.equal(result.status, 0, result.stderr);
    const names = JSON.parse(result.stdout)[0].files.map((entry) => entry.path);
    assert.ok(names.includes("lib/index.js"));
    assert.ok(!names.includes("lib/WORKING.md"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source export copies only explicit inputs and carries no repository history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "public-source-"));
  const { mkdir, readFile, readdir } = await import("node:fs/promises");
  try {
    const source = join(directory, "source");
    await mkdir(source);
    await mkdir(join(source, ".git"));
    await writeFile(join(source, "README.md"), "Public instructions.\n");
    await writeFile(join(source, "WORKING.md"), "Synthetic private continuation.\n");
    await writeFile(join(source, "public-source-files.json"), JSON.stringify({
      schemaVersion: 1, files: ["README.md", "public-source-files.json"],
    }));
    const target = join(directory, "public", "nested");
    await exportPublicSource(source, target);
    assert.deepEqual((await readdir(target)).sort(), ["README.md", "public-source-files.json"]);
    assert.equal(await readFile(join(target, "README.md"), "utf8"), "Public instructions.\n");
    await assert.rejects(exportPublicSource(source, target), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
