#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const sourceType = valueAfter("--source");
const publishTimestamp = Number(valueAfter("--publish-timestamp"));
const output = resolve(root, valueAfter("--output") || ".local/release/blue-fat-fish-market-index.json");
const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const listing = JSON.parse(await readFile(resolve(root, "marketplace/listing.json"), "utf8"));

if (!Number.isSafeInteger(publishTimestamp) || publishTimestamp <= 0) {
  throw new Error("--publish-timestamp must be the actual publication time in Unix seconds");
}

let source;
if (sourceType === "npm") {
  const registry = valueAfter("--registry");
  source = registry ? { type: "npm", registry } : { type: "npm" };
} else if (sourceType === "git") {
  throw new Error("git installation is not supported by this index builder; use the npm package source");
} else {
  throw new Error("--source must be npm");
}

const index = {
  format: 1,
  title: { en: "Blue Fat Fish · OpenAdam Edition", "zh-cn": "蓝色大肥鱼 · OpenAdam 版" },
  description: {
    en: "The market feed for OpenAdam's unofficial Blue Fat Fish desktop companion.",
    "zh-cn": "OpenAdam 版非官方蓝色大肥鱼桌宠市场源。",
  },
  metadata: {
    categories: { experience: { title: { en: "Experience", "zh-cn": "体验" } } },
    labels: {
      "data-only-bundles": { title: { en: "Data-only bundles", "zh-cn": "纯数据伙伴包" } },
    },
    sortKeys: {},
  },
  plugins: [{
    name: packageManifest.name,
    title: listing.title,
    description: listing.description,
    author: listing.author,
    homepage: listing.homepage,
    metadata: {
      category: listing.category,
      keywords: listing.keywords,
      labels: listing.labels,
      sortKeys: {},
    },
    versions: [{
      version: packageManifest.version,
      publishTimestamp,
      source,
      engines: { dsh: packageManifest.engines.dsh },
    }],
  }],
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(`${output}\n`);
