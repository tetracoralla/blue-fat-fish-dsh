#!/usr/bin/env node

import { copyFile, lstat, mkdir, readFile, realpath, chmod } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export async function exportPublicSource(sourceRoot, output) {
  const root = await realpath(sourceRoot);
  const target = resolve(output);
  if (target === root || relative(target, root).split(sep)[0] !== "..") {
    throw new Error("output must not contain or replace the source root");
  }
  const manifest = JSON.parse(await readFile(resolve(root, "public-source-files.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length ||
      new Set(manifest.files).size !== manifest.files.length) {
    throw new Error("invalid public source file allowlist");
  }
  const checked = [];
  for (const name of manifest.files) {
    if (typeof name !== "string" || isAbsolute(name) || name.includes("\\") ||
        name.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) {
      throw new Error("invalid public source path");
    }
    let path = root;
    for (const part of name.split("/")) {
      path = resolve(path, part);
      if ((await lstat(path)).isSymbolicLink()) throw new Error("public source cannot contain symlinks");
    }
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("public source entry must be a regular file");
    checked.push({ name, path, mode: info.mode & 0o777 });
  }
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target);
  for (const { name, path, mode } of checked) {
    const destination = resolve(target, name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(path, destination);
    await chmod(destination, mode);
  }
  return checked.map(({ name }) => name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => args[args.indexOf(name) + 1];
  if (!args.includes("--output")) throw new Error("--output must name a new directory");
  const root = args.includes("--root") ? option("--root") : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = await exportPublicSource(root, option("--output"));
  process.stdout.write(JSON.stringify({ ok: true, fileCount: files.length }) + "\n");
}
