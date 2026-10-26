import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { EdgeHelperController } from "../lib/edge-helper.js";

let client;
const clientSource = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
vm.runInNewContext(clientSource, {
  window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(() => ({})); } } },
  crypto: { randomUUID: () => "test-view" },
});
const snapshot = (running, waiting = false, jobs = []) => ({
  ids: ["one"], byId: { one: { running, pendingInteraction: waiting ? { id: "question" } : null } },
  jobsBySession: { one: jobs },
});

test("current host state survives waiting resolution and initial attachment", () => {
  const update = client.createSessionMotion();
  assert.equal(update(snapshot(true, true)).base, "waiting");
  assert.equal(update(snapshot(true)).base, "running");
  const completed = update(snapshot(false));
  assert.equal(completed.base, "idle");
  assert.equal(completed.cue, "review");
  assert.equal(update(snapshot(false)).cue, null);
});

test("each new failure performs once without old failures masking work or later failures", () => {
  const update = client.createSessionMotion();
  const old = { id: "old", status: "failed" };
  assert.equal(update(snapshot(false, false, [old])).cue, null);
  assert.equal(update(snapshot(true, false, [old])).base, "running");
  const first = update(snapshot(false, false, [old, { id: "new", status: "failed" }]));
  assert.equal(first.cue, "failed");
  assert.equal(update(snapshot(false, false, [old, { id: "new", status: "failed" }])).cue, null);
  const second = update(snapshot(true, false, [old, { id: "new", status: "failed" }, { id: "later", status: "failed" }]));
  assert.equal(second.cue, "failed");
  assert.notEqual(first.eventID, second.eventID);
});

test("one remaining running session prevents a completion performance", () => {
  const update = client.createSessionMotion();
  update(snapshot(true));
  const next = update({ ids: ["one", "two"], byId: { one: { running: false }, two: { running: true } } });
  assert.equal(next.base, "running");
  assert.equal(next.cue, null);
});

test("native backpressure retains the latest base and a pending event", () => {
  const controller = new EdgeHelperController();
  controller.stdinBackpressured = true;
  controller.updatePetState({ base: "running", cue: "failed", eventID: "f1" });
  controller.updatePetState({ base: "waiting" });
  assert.equal(controller.pendingPetCues[0].cue, "failed");
  assert.equal(controller.latestPetState.base, "waiting");
  controller.updatePetState({ base: "idle", cue: "review", eventID: "c1" });
  controller.updatePetState({ base: "running" });
  assert.equal(controller.pendingPetCues.some((item) => item.cue === "review"), false);
  assert.equal(controller.latestPetState.cue, null);
  assert.equal(controller.updatePetState({ base: "running", cue: "failed" }), false);
  assert.equal(controller.updatePetState({ base: "garbage" }), false);
  controller.stop();
  assert.equal(controller.petState.base, "running");
});

test("native helper publishes the newest accepted layout to every browser projection", () => {
  const controller = new EdgeHelperController();
  const received = [];
  const unsubscribe = controller.subscribeLayout((snapshot) => received.push(snapshot));
  assert.equal(controller.status().layoutSubscribers, 1);
  assert.equal(controller.receiveHelperLine(JSON.stringify({
    kind: "edge-layout",
    geometry: {
      width: 640, height: 777.6, effectiveOutside: 300,
      hostEdgeX: 340, hostTopY: 57.6, scale: 1,
    },
  })), true);
  assert.equal(controller.receiveHelperLine(JSON.stringify({
    kind: "edge-layout",
    geometry: {
      width: 640, height: 777.6, effectiveOutside: 300,
      hostEdgeX: 340, hostTopY: 57.6, scale: 1,
    },
  })), true);
  assert.equal(controller.receiveHelperLine("not protocol data"), false);
  assert.deepEqual(received, [{
    revision: 1,
    geometry: {
      width: 640, height: 777.6, effectiveOutside: 300,
      hostEdgeX: 340, hostTopY: 57.6, scale: 1,
    },
  }]);
  assert.equal(controller.status().layoutRevision, 1);
  unsubscribe();
  assert.equal(controller.status().layoutSubscribers, 0);
  controller.stop();
});

test("motion inbox and native transport preserve three consecutive cues in order", () => {
  const inbox = client.createMotionInbox();
  assert.equal(inbox.push({ base: "running", cue: "failed", eventID: "f1" }).eventID, "f1");
  assert.equal(inbox.push({ base: "running", cue: "failed", eventID: "f2" }).eventID, "f1");
  assert.equal(inbox.push({ base: "idle", cue: "review", eventID: "r1" }).eventID, "f1");
  assert.equal(inbox.acknowledge("f1").eventID, "f2");
  assert.equal(inbox.acknowledge("f2").eventID, "r1");
  assert.equal(inbox.acknowledge("r1").cue, null);

  const controller = new EdgeHelperController();
  controller.stdinBackpressured = true;
  controller.updatePetState({ base: "running", cue: "failed", eventID: "f1" });
  controller.updatePetState({ base: "running", cue: "failed", eventID: "f2" });
  controller.updatePetState({ base: "running", cue: "failed", eventID: "f3" });
  assert.deepEqual(controller.pendingPetCues.map((item) => item.eventID), ["f1", "f2", "f3"]);
  controller.stop();
});

test("pointer jitter remains a click and cancellation rolls drag preview back", () => {
  assert.equal(client.isDeliberateDrag(2, 3), false);
  assert.equal(client.isDeliberateDrag(3, 3), true);
  const value = { originX: 40, originY: 80, latest: { x: 140, y: 180 } };
  const plain = (result) => JSON.parse(JSON.stringify(result));
  assert.deepEqual(plain(client.dragRelease(value, false, false)), {
    position: { x: 40, y: 80 }, persist: false,
  });
  assert.deepEqual(plain(client.dragRelease(value, true, true)), {
    position: { x: 40, y: 80 }, persist: false,
  });
  assert.deepEqual(plain(client.dragRelease(value, true, false)), {
    position: { x: 140, y: 180 }, persist: true,
  });
});

test("edge host sampling sleeps while stationary and wakes briefly during movement", () => {
  assert.equal(client.edgeHostFrameDelay(false, true), 250);
  assert.equal(client.edgeHostFrameDelay(true, true), 16);
  assert.equal(client.edgeHostFrameDelay(true, false), 1000);
});

test("one visual frame prefers native geometry and keeps local measurement as its fallback", () => {
  const local = {
    width: 640.04, height: 777.56, effectiveOutside: 300.04,
    hostEdgeX: 340.04, hostTopY: 57.56, scale: 1,
  };
  const native = {
    width: 620, height: 755, effectiveOutside: 290,
    hostEdgeX: 330, hostTopY: 55, scale: 0.9,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(client.chooseEdgeGeometryFrame(null, local))), {
    width: 640, height: 777.6, effectiveOutside: 300,
    hostEdgeX: 340, hostTopY: 57.6, scale: 1,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(client.chooseEdgeGeometryFrame(native, local))), native);
  assert.equal(client.edgeGeometryKey(local), "640:777.6:300:340:57.6:1");
  assert.equal(client.normalizeEdgeGeometry({
    width: 640, height: 778, effectiveOutside: 300,
    hostEdgeX: 900, hostTopY: 58, scale: 1,
  }), null);
});

test("identical edge geometry does not rewrite inherited CSS variables", () => {
  const writes = [];
  const element = { style: { setProperty: (name, value) => writes.push([name, value]) } };
  const geometry = {
    width: 640, height: 777.6, effectiveOutside: 300,
    hostEdgeX: 340, hostTopY: 57.6, scale: 1,
  };
  client.applyEdgeGeometry(element, geometry);
  client.applyEdgeGeometry(element, { ...geometry });
  assert.equal(writes.length, 5);
});

test("edge geometry remains host-relative beyond any display boundary", () => {
  const presentation = {
    insideWidth: 340, outsideWidth: 300, heightRatio: 1.08,
    maximumHeight: 900, shrinkThreshold: 960, minimumResponsiveScale: 0.68,
  };
  const first = client.measureEdgeGeometry(presentation, { x: 100, y: 80, width: 980, height: 720 });
  const pastRight = client.measureEdgeGeometry(presentation, { x: 4_000, y: -900, width: 980, height: 720 });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    width: 640, height: 777.6, effectiveOutside: 300, hostEdgeX: 340, hostTopY: 57.6, scale: 1,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(pastRight)), JSON.parse(JSON.stringify(first)));
});

test("only a maximized frame contains the right extension", () => {
  const screen = { availLeft: 0, availTop: 25, availWidth: 1440, availHeight: 875 };
  assert.equal(client.isMaximizedHostFrame(
    { x: 0, y: 25, width: 1440, height: 875 }, screen,
  ), true);
  assert.equal(client.isMaximizedHostFrame(
    { x: 440, y: 175, width: 1000, height: 725 }, screen,
  ), false);
  const contained = client.measureEdgeGeometry({
    insideWidth: 340, outsideWidth: 300, heightRatio: 1.08,
    maximumHeight: 900, shrinkThreshold: 960, minimumResponsiveScale: 0.68,
  }, { x: 0, y: 25, width: 1440, height: 875, containRightEdge: true });
  assert.equal(contained.effectiveOutside, 0);
  assert.equal(contained.hostEdgeX, contained.width);
});

test("runtime motion reports cannot trigger the configuration refresh loop", () => {
  assert.equal(client.isRuntimeStatePost("/api/openadam-companions/pet-state"), true);
  assert.equal(client.isRuntimeStatePost("/api/openadam-companions/edge-frame"), true);
  assert.equal(client.isRuntimeStatePost("/api/openadam-companions/preferences"), false);
});

test("settings exposes one atomic appearance choice instead of separate body and skin selectors", () => {
  assert.match(clientSource, /preferences\.appearanceId === appearance\.id/);
  assert.match(clientSource, /preference\(\{ appearanceId: appearance\.id \}\)/);
  assert.match(clientSource, /active\.companion\.appearances\.length > 1/);
  assert.match(clientSource, /"装扮"/);
});

test("settings does not claim that a display adapter creates a companion identity", () => {
  assert.match(clientSource, /出生起点 · DSH 仅显示，不创建身份/);
  assert.doesNotMatch(clientSource, /打开后产生新身份/);
});

test("portable market UI does not promise an independent native desktop pet", () => {
  assert.match(clientSource, /显示 Q 版伙伴/);
  assert.match(clientSource, /state\.edgeExtension && state\.edgeExtension\.available/);
});

test("edge extension preserves seam pixels and tones only the deeper interior", () => {
  assert.match(clientSource, /oa-shell-skin__character-plane/);
  assert.match(clientSource, /requestAnimationFrame/);
  const baseRule = clientSource.match(
    /\.oa-shell-skin\.edge-extension-on \.oa-shell-skin__character\{([^}]*)\}/,
  );
  assert.ok(baseRule, "edge-extension character override is present");
  assert.match(baseRule[1], /opacity:1(?:;|$)/);
  assert.match(baseRule[1], /filter:none(?:;|$)/);
  assert.match(baseRule[1], /-webkit-mask-image:none(?:;|$)/);
  assert.match(baseRule[1], /mask-image:none(?:;|$)/);
  assert.match(baseRule[1], /animation:none!important(?:;|$)/);

  const toneRule = clientSource.match(
    /\.oa-shell-skin\.edge-extension-on \.oa-shell-skin__character--inside-tone\{([^}]*)\}/,
  );
  assert.ok(toneRule, "interior tone layer is present");
  assert.match(toneRule[1], /filter:brightness\(\.88\) saturate\(\.96\) contrast\(\.99\)/);
  assert.match(toneRule[1], /var\(--oa-edge-split-x\)/);
  assert.match(toneRule[1], /var\(--oa-edge-split-y\)/);
  assert.match(toneRule[1], /mask-composite:intersect/);
});
