import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BodyRendererController,
  bodyRendererArguments,
  parseBodyRendererLine,
} from "../lib/body-renderer.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, milliseconds = 5_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("timed out waiting for body renderer state");
}

test("builds and parses the versioned external body-renderer protocol", () => {
  assert.deepEqual(bodyRendererArguments(
    { preferences: { scale: 1.4 } },
    {
      contract: "openadam.body-renderer.v1",
      format: "live2d.cubism.model3.v1",
      entryPath: "/safe/model.model3.json",
    },
    42,
  ), [
    "--contract", "openadam.body-renderer.v1",
    "--format", "live2d.cubism.model3.v1",
    "--entry", "/safe/model.model3.json",
    "--scale", "1.4",
    "--parent-pid", "42",
  ]);
  assert.deepEqual(parseBodyRendererLine(JSON.stringify({
    kind: "ready", contract: "openadam.body-renderer.v1", format: "live2d.cubism.model3.v1",
  })), {
    contract: "openadam.body-renderer.v1", format: "live2d.cubism.model3.v1",
  });
  assert.equal(parseBodyRendererLine('{"kind":"ready","contract":"wrong"}'), null);
});

test("uses the sprite fallback until a renderer completes the handshake", async () => {
  const root = await mkdtemp(join(tmpdir(), "openadam-body-renderer-"));
  const executable = join(root, "renderer");
  await writeFile(executable, "#!/bin/sh\necho '{\"kind\":\"ready\",\"contract\":\"openadam.body-renderer.v1\",\"format\":\"live2d.cubism.model3.v1\"}'\nwhile IFS= read -r line; do :; done\n");
  await chmod(executable, 0o700);
  const changes = [];
  const controller = new BodyRendererController({
    executable, platform: "darwin", handshakeMilliseconds: 5_000,
    onStatusChange: () => changes.push(controller.status()),
  });
  const state = {
    preferences: { petEnabled: true, scale: 1.2 },
    active: {
      id: "studio.openadam.test",
      projection: { contract: "openadam.body-renderer.v1" },
      companion: { activeAppearanceId: "default" },
    },
  };
  const library = { bodyProjectionPaths: async () => ({
    contract: "openadam.body-renderer.v1",
    format: "live2d.cubism.model3.v1",
    entryPath: join(root, "model.model3.json"),
    assetPaths: [],
  }) };
  try {
    await controller.init();
    const starting = await controller.sync(state, library);
    assert.equal(starting.ready, false);
    await waitFor(() => controller.status().ready);
    assert.equal(controller.status().ready, true);
    assert.ok(changes.some((status) => status.ready));
    assert.equal(controller.updatePetState({ base: "running", cue: "failed", eventID: "f1" }), true);
  } finally {
    controller.stop({ clearFailure: true });
    await rm(root, { recursive: true, force: true });
  }
});
