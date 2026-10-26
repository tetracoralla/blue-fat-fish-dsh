/* Blue Fat Fish, OpenAdam edition, for DSH. Data comes through the public Host API;
 * rendering uses shell.overlay, settings.section and the official theme token
 * override service. No private DOM selectors or shell source patches. */
window.__ModuleLoader__.load({
  id: "@openadam/blue-fat-fish",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useMemo = React.useMemo;
    var useCallback = React.useCallback;

    var listeners = [];
    function emitChanged() { listeners.slice().forEach(function (listener) { try { listener(); } catch (_) {} }); }
    function onChanged(listener) {
      listeners.push(listener);
      return function () { var index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
    }

    function stateRequest() {
      return fetch("/api/openadam-companions", { signal: AbortSignal.timeout(8000) })
        .then(function (response) { return response.json(); })
        .then(function (body) {
          if (!body || !body.ok) throw new Error(body && body.error ? body.error.message : "组合包状态读取失败");
          return body;
        });
    }

    function isRuntimeStatePost(path) {
      return path === "/api/openadam-companions/pet-state" || path === "/api/openadam-companions/edge-frame";
    }

    function post(path, body, raw) {
      var options = { method: "POST", signal: AbortSignal.timeout(30000) };
      if (raw) options.body = body;
      else { options.body = JSON.stringify(body); options.headers = { "content-type": "application/json" }; }
      return fetch(path, options).then(function (response) { return response.json(); }).then(function (result) {
        if (!result || !result.ok) throw new Error(result && result.error ? result.error.message : "操作失败");
        if (!isRuntimeStatePost(path)) emitChanged();
        return result;
      });
    }

    function paletteTokens(theme) {
      if (!theme || !theme.light || !theme.dark) return null;
      var map = {
        "--dsw-alias-bg-base": "canvas",
        "--dsw-alias-bg-layer-1": "surface",
        "--dsw-alias-bg-layer-2": "surfaceRaised",
        "--dsw-alias-bg-overlay": "overlay",
        "--dsw-alias-border-l1": "border",
        "--dsw-alias-border-l2": "borderStrong",
        "--dsw-alias-brand-primary": "accent",
        "--dsw-alias-label-primary": "textPrimary",
        "--dsw-alias-label-secondary": "textSecondary",
        "--dsw-alias-state-error-primary": "danger",
        "--dsw-alias-state-idle-primary": "idle",
        "--dsw-alias-state-success-primary": "success",
        "--dsw-alias-state-warn-primary": "warning",
        "--dsw-specific-sidebar-fill": "sidebar",
      };
      var output = {};
      Object.keys(map).forEach(function (token) {
        var key = map[token];
        output[token] = { light: theme.light[key], dark: theme.dark[key] };
      });
      return output;
    }

    function animationFrames(pet, name) {
      var table = pet && pet.animations ? pet.animations : {};
      var animation = table[name] || table.idle;
      if (!animation || !Array.isArray(animation.frames)) return [[0, 600]];
      var fpsDuration = animation.fps ? Math.round(1000 / animation.fps) : 120;
      return animation.frames.map(function (frame, index) {
        var duration = Array.isArray(animation.durationsMilliseconds)
          ? animation.durationsMilliseconds[index]
          : fpsDuration;
        return [frame, duration];
      });
    }

    function assetUrl(id, path) {
      return "/openadam-companion-assets/" + encodeURIComponent(id) + "/" + path.split("/").map(encodeURIComponent).join("/");
    }

    function isDeliberateDrag(deltaX, deltaY) {
      return Math.abs(deltaX) + Math.abs(deltaY) > 5;
    }

    function dragRelease(value, moved, cancelled) {
      return {
        position: cancelled || !moved
          ? { x: value.originX, y: value.originY }
          : { x: value.latest.x, y: value.latest.y },
        persist: Boolean(moved && !cancelled),
      };
    }

    // The host projection is shared by the skin and both body renderers. Old
    // failed jobs are history; only a newly failed job produces a performance.
    function createSessionMotion() {
      var previous = null;
      var sequence = 0;
      var source = globalThis.crypto && globalThis.crypto.randomUUID
        ? globalThis.crypto.randomUUID() : String(Date.now()) + "-" + Math.random();
      return function (snapshot) {
        snapshot = snapshot || {};
        var byId = snapshot.byId || {};
        var ids = snapshot.ids || Object.keys(byId);
        var running = ids.some(function (id) { return byId[id] && byId[id].running; });
        var waiting = ids.some(function (id) { return byId[id] && byId[id].pendingInteraction; });
        var failures = [];
        Object.entries(snapshot.jobsBySession || {}).forEach(function (entry) {
          (Array.isArray(entry[1]) ? entry[1] : []).forEach(function (job, index) {
            if (job && job.status === "failed") failures.push(entry[0] + ":" + (job.id || job.jobId || index));
          });
        });
        var base = waiting ? "waiting" : running ? "running" : "idle";
        var cue = null;
        if (previous) {
          if (failures.some(function (id) { return !previous.failures.includes(id); })) cue = "failed";
          else if (previous.running && !running && !waiting) cue = "review";
        }
        previous = { running: running, failures: failures };
        return { base: base, cue: cue, eventID: cue ? source + ":" + (++sequence) : null };
      };
    }

    function createMotionInbox(maximumCues) {
      var limit = Math.max(1, Math.min(Number(maximumCues) || 16, 64));
      var base = "idle";
      var cues = [];
      function current() {
        var next = cues[0];
        return { base: base, cue: next ? next.cue : null, eventID: next ? next.eventID : null };
      }
      return {
        push: function (motion, cueEnabled) {
          motion = motion || {};
          if (["idle", "running", "waiting"].includes(motion.base)) base = motion.base;
          if (base !== "idle") cues = cues.filter(function (item) { return item.cue !== "review"; });
          if (cueEnabled !== false && motion.cue && motion.eventID &&
              !(motion.cue === "review" && base !== "idle") &&
              !cues.some(function (item) { return item.eventID === motion.eventID; })) {
            cues.push({ cue: motion.cue, eventID: motion.eventID });
            if (cues.length > limit) cues.splice(0, cues.length - limit);
          }
          return current();
        },
        acknowledge: function (eventID) {
          if (eventID) cues = cues.filter(function (item) { return item.eventID !== eventID; });
          return current();
        },
      };
    }

    function useSessionMotion(sessions, cueEnabled) {
      var state = useState({ base: "idle", cue: null, eventID: null });
      var inbox = useRef(createMotionInbox());
      var acknowledge = useCallback(function (eventID) {
        state[1](inbox.current.acknowledge(eventID));
      }, []);
      useEffect(function () {
        var store = sessions && sessions.list;
        if (!store || typeof store.getSnapshot !== "function" || typeof store.subscribe !== "function") return;
        var project = createSessionMotion();
        inbox.current = createMotionInbox();
        function read() {
          var snapshot;
          try { snapshot = store.getSnapshot(); } catch (_) { return; }
          if (snapshot) state[1](inbox.current.push(project(snapshot), cueEnabled));
        }
        read();
        var dispose = store.subscribe(read);
        return typeof dispose === "function" ? dispose : undefined;
      }, [sessions, cueEnabled]);
      return { ...state[0], acknowledge: acknowledge };
    }

    function roundedGeometry(value) { return Math.round(value * 10) / 10; }

    function isMaximizedHostFrame(hostFrame, availableScreen) {
      hostFrame = hostFrame || {};
      availableScreen = availableScreen || {};
      var x = Number(hostFrame.x);
      var y = Number(hostFrame.y);
      var width = Number(hostFrame.width);
      var height = Number(hostFrame.height);
      var left = Number(availableScreen.availLeft);
      var top = Number(availableScreen.availTop);
      var screenWidth = Number(availableScreen.availWidth);
      var screenHeight = Number(availableScreen.availHeight);
      if (![x, y, width, height, left, top, screenWidth, screenHeight].every(Number.isFinite) ||
          width < 1 || height < 1 || screenWidth < 1 || screenHeight < 1) return false;
      var tolerance = 3;
      return Math.abs(x - left) <= tolerance && Math.abs(y - top) <= tolerance &&
        Math.abs(x + width - left - screenWidth) <= tolerance &&
        Math.abs(y + height - top - screenHeight) <= tolerance;
    }

    function measureEdgeGeometry(presentation, hostFrame) {
      presentation = presentation || {};
      hostFrame = hostFrame || {};
      var inside = Number(presentation.insideWidth) || 340;
      var outside = Number(presentation.outsideWidth) || 300;
      var heightRatio = Number(presentation.heightRatio) || 1.08;
      var maximumHeight = Number(presentation.maximumHeight) || 900;
      var shrinkThreshold = Number(presentation.shrinkThreshold) || 960;
      var minimumResponsiveScale = Number(presentation.minimumResponsiveScale) || 0.68;
      var hostWidth = Math.max(1, Number(hostFrame.width) || Number(window.outerWidth) || window.innerWidth || 1);
      var hostHeight = Math.max(1, Number(hostFrame.height) || Number(window.outerHeight) || window.innerHeight || 1);
      var baseWidth = inside + outside;
      var baseHeight = Math.max(1, Math.min(hostHeight * Math.max(heightRatio, 0.01), Math.max(maximumHeight, 1)));
      var preferredScale = Math.max(
        Math.min(minimumResponsiveScale, 1),
        Math.min(1, hostWidth / Math.max(shrinkThreshold, 1))
      );
      var actualScale = Math.max(0.01, Math.min(
        1,
        preferredScale,
        hostWidth / Math.max(inside, 1)
      ));
      var width = baseWidth * actualScale;
      var height = baseHeight * actualScale;
      var containRightEdge = hostFrame.containRightEdge === true;
      var effectiveOutside = containRightEdge ? 0 : outside * actualScale;
      return {
        width: roundedGeometry(width),
        height: roundedGeometry(height),
        effectiveOutside: roundedGeometry(effectiveOutside),
        hostEdgeX: roundedGeometry(containRightEdge ? width : Math.min(width, Math.max(0, width - effectiveOutside))),
        hostTopY: roundedGeometry(Math.max(0, height - hostHeight)),
        scale: roundedGeometry(actualScale),
      };
    }

    function normalizeEdgeGeometry(value) {
      if (!value || typeof value !== "object") return null;
      var keys = ["width", "height", "effectiveOutside", "hostEdgeX", "hostTopY", "scale"];
      var numbers = {};
      keys.forEach(function (key) { numbers[key] = Number(value[key]); });
      if (!keys.every(function (key) { return Number.isFinite(numbers[key]); }) ||
          numbers.width < 1 || numbers.width > 10000 ||
          numbers.height < 1 || numbers.height > 10000 ||
          numbers.effectiveOutside < 0 || numbers.effectiveOutside > numbers.width ||
          numbers.hostEdgeX < 0 || numbers.hostEdgeX > numbers.width ||
          numbers.hostTopY < 0 || numbers.hostTopY > numbers.height ||
          numbers.scale < 0.01 || numbers.scale > 2) return null;
      var output = {};
      keys.forEach(function (key) { output[key] = roundedGeometry(numbers[key]); });
      return output;
    }

    function edgeGeometryKey(value) {
      var geometry = normalizeEdgeGeometry(value);
      return geometry ? [
        geometry.width, geometry.height, geometry.effectiveOutside,
        geometry.hostEdgeX, geometry.hostTopY, geometry.scale,
      ].join(":") : "";
    }

    function chooseEdgeGeometryFrame(nativeGeometry, localGeometry) {
      return normalizeEdgeGeometry(nativeGeometry) || normalizeEdgeGeometry(localGeometry);
    }

    var EDGE_HOST_FRAME_EVENT = "openadam-companion:edge-host-frame";

    // Window position has no portable DOM event. Poll gently while it is still,
    // then briefly accelerate after the first changed sample so a drag remains
    // visually attached without keeping Chromium on a permanent display-rate
    // requestAnimationFrame loop.
    function edgeHostFrameDelay(active, visible) {
      if (!visible) return 1000;
      return active ? 16 : 250;
    }

    function useEdgeHostFrameStream(enabled, presentation) {
      useEffect(function () {
        if (!enabled) return;
        var stopped = false;
        var timer = 0;
        var inFlight = false;
        var queued = null;
        var lastFrameKey = "";
        var lastSizeKey = "";
        var lastSentAt = 0;
        var activeUntil = 0;
        var layoutStream = null;
        var visualFrame = 0;
        var pendingNativeGeometry = null;
        var pendingLocalGeometry = null;
        var lastPublishedGeometryKey = "";

        function requestVisualFrame(callback) {
          return typeof window.requestAnimationFrame === "function"
            ? window.requestAnimationFrame(callback)
            : window.setTimeout(callback, 16);
        }

        function cancelVisualFrame(frame) {
          if (!frame) return;
          if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
          else window.clearTimeout(frame);
        }

        function publishGeometry(geometry) {
          var key = edgeGeometryKey(geometry);
          if (!key || key === lastPublishedGeometryKey) return;
          lastPublishedGeometryKey = key;
          window.dispatchEvent(new CustomEvent(EDGE_HOST_FRAME_EVENT, {
            detail: { geometry: geometry },
          }));
        }

        function queueVisualGeometry(geometry, native) {
          var normalized = normalizeEdgeGeometry(geometry);
          if (!normalized) return;
          if (native) pendingNativeGeometry = normalized;
          else pendingLocalGeometry = normalized;
          if (visualFrame) return;
          visualFrame = requestVisualFrame(function () {
            visualFrame = 0;
            var next = chooseEdgeGeometryFrame(pendingNativeGeometry, pendingLocalGeometry);
            pendingNativeGeometry = null;
            pendingLocalGeometry = null;
            if (next) publishGeometry(next);
          });
        }

        if (typeof window.EventSource === "function") {
          layoutStream = new window.EventSource("/api/openadam-companions/edge-layout-stream");
          layoutStream.onmessage = function (event) {
            var geometry = null;
            try { geometry = normalizeEdgeGeometry(JSON.parse(event.data)); } catch (_) {}
            if (!geometry) return;
            queueVisualGeometry(geometry, true);
          };
        }

        function flush() {
          if (stopped || inFlight || !queued) return;
          var sample = queued;
          queued = null;
          inFlight = true;
          fetch("/api/openadam-companions/edge-frame", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(sample),
            signal: AbortSignal.timeout(1000),
          }).catch(function () {}).finally(function () {
            inFlight = false;
            flush();
          });
        }

        function capture(force) {
          var x = Number(window.screenX);
          var y = Number(window.screenY);
          var width = Number(window.outerWidth);
          var height = Number(window.outerHeight);
          if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return;
          var frameKey = [x, y, width, height].join(":");
          var containRightEdge = isMaximizedHostFrame(
            { x: x, y: y, width: width, height: height },
            window.screen
          );
          var sizeKey = [width, height, containRightEdge].join(":");
          var now = Date.now();
          var changed = frameKey !== lastFrameKey;
          if (changed) {
            activeUntil = now + 220;
          }
          if (sizeKey !== lastSizeKey) {
            lastSizeKey = sizeKey;
            queueVisualGeometry(measureEdgeGeometry(presentation, {
              width: width, height: height, containRightEdge: containRightEdge,
            }), false);
          }
          if (!force && !changed && now - lastSentAt < 2000) return;
          lastFrameKey = frameKey;
          lastSentAt = now;
          queued = { x: x, y: y, width: width, height: height };
          flush();
        }

        function tick() {
          capture(false);
          timer = window.setTimeout(tick, edgeHostFrameDelay(
            Date.now() < activeUntil,
            document.visibilityState !== "hidden"
          ));
        }
        function forceCapture() {
          activeUntil = Date.now() + 220;
          capture(true);
        }
        capture(true);
        timer = window.setTimeout(tick, edgeHostFrameDelay(false, document.visibilityState !== "hidden"));
        window.addEventListener("resize", forceCapture, { passive: true });
        window.addEventListener("focus", forceCapture, { passive: true });
        document.addEventListener("visibilitychange", forceCapture, { passive: true });
        return function () {
          stopped = true;
          if (timer) window.clearTimeout(timer);
          window.removeEventListener("resize", forceCapture);
          window.removeEventListener("focus", forceCapture);
          document.removeEventListener("visibilitychange", forceCapture);
          cancelVisualFrame(visualFrame);
          visualFrame = 0;
          pendingNativeGeometry = null;
          pendingLocalGeometry = null;
          if (layoutStream) layoutStream.close();
        };
      }, [enabled, presentation && presentation.insideWidth, presentation && presentation.outsideWidth,
        presentation && presentation.heightRatio, presentation && presentation.maximumHeight,
        presentation && presentation.shrinkThreshold, presentation && presentation.minimumResponsiveScale]);
    }

    function applyEdgeGeometry(element, geometry) {
      if (!element || !geometry) return;
      var key = edgeGeometryKey(geometry);
      if (!key || element.__oaEdgeGeometryKey === key) return;
      element.__oaEdgeGeometryKey = key;
      element.style.setProperty("--oa-edge-width", geometry.width + "px");
      element.style.setProperty("--oa-edge-outside", geometry.effectiveOutside + "px");
      element.style.setProperty("--oa-edge-height", geometry.height + "px");
      element.style.setProperty("--oa-edge-split-x", geometry.hostEdgeX + "px");
      element.style.setProperty("--oa-edge-split-y", geometry.hostTopY + "px");
    }

    function useEdgeGeometry(enabled, presentation) {
      var elementRef = useRef(null);
      var geometryRef = useRef(measureEdgeGeometry(presentation));
      useEffect(function () {
        if (!enabled) return;
        function update(event) {
          var detail = event && event.detail;
          var next = detail && detail.geometry ? detail.geometry : measureEdgeGeometry(presentation, detail);
          geometryRef.current = next;
          applyEdgeGeometry(elementRef.current, next);
        }
        update();
        window.addEventListener(EDGE_HOST_FRAME_EVENT, update, { passive: true });
        return function () {
          window.removeEventListener(EDGE_HOST_FRAME_EVENT, update);
        };
      }, [enabled, presentation && presentation.insideWidth, presentation && presentation.outsideWidth,
        presentation && presentation.heightRatio, presentation && presentation.maximumHeight,
        presentation && presentation.shrinkThreshold, presentation && presentation.minimumResponsiveScale]);
      return { elementRef: elementRef, geometry: geometryRef.current };
    }

    var skinCss = `
      [data-slot="root"] :has(>[data-slot="shell.overlay"]){z-index:0!important}
      [data-slot="root"] :has(>[data-slot="sidebar"]),[data-slot="root"] :has(>[data-slot="main"]),[data-slot="root"] :has(>[data-slot="rightbar"]){position:relative;z-index:1}
      [data-slot="root"] :has(>[data-slot="main"]){background-color:transparent!important}
      [data-slot="main.conversation"]>*{background-color:transparent!important}
      .oa-shell-skin{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;contain:layout paint;isolation:isolate;-webkit-mask-image:linear-gradient(90deg,#000 0%,#000 calc(100% - 72px),rgba(0,0,0,.42) calc(100% - 24px),transparent 100%);mask-image:linear-gradient(90deg,#000 0%,#000 calc(100% - 72px),rgba(0,0,0,.42) calc(100% - 24px),transparent 100%);--oa-cyan:#7cecff;--oa-gold:#e8c879;--oa-skin-scale:1}
      .oa-shell-skin__veil{position:absolute;z-index:0;inset:0;background:radial-gradient(ellipse 40% 92% at 107% 52%,rgba(16,83,119,.23) 0%,rgba(4,35,57,.14) 48%,transparent 78%),linear-gradient(90deg,transparent 68%,rgba(1,15,27,.15) 100%);opacity:.8}
      .oa-shell-skin__atmosphere{position:absolute;z-index:1;right:-1vw;bottom:-4vh;width:min(80vw,1440px);height:auto;object-fit:contain;object-position:right bottom;opacity:.3;filter:brightness(.7) saturate(.78) contrast(.94);-webkit-mask-image:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.18) 12%,#000 34%,#000 100%);mask-image:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.18) 12%,#000 34%,#000 100%)}
      .oa-shell-skin__edge{position:absolute;z-index:2;right:-130px;top:-8vh;width:clamp(260px,24vw,460px);height:116vh;border-radius:68% 0 0 42% / 18% 0 0 82%;background:radial-gradient(ellipse at 74% 50%,rgba(28,124,165,.13),rgba(7,42,65,.08) 54%,transparent 74%);box-shadow:-22px 0 70px rgba(19,102,140,.08);opacity:.72}
      .oa-shell-skin__edge:before,.oa-shell-skin__edge:after{content:"";position:absolute;left:-34%;width:78%;height:34%;border:1px solid rgba(110,210,232,.13);border-right:0;border-radius:58% 0 0 52%;filter:blur(.15px)}
      .oa-shell-skin__edge:before{top:14%;transform:rotate(-7deg)}.oa-shell-skin__edge:after{bottom:11%;transform:rotate(8deg);border-color:rgba(232,200,121,.1)}
      .oa-shell-skin__character-plane{position:absolute;inset:0;pointer-events:none;contain:style}
      .oa-shell-skin__character{position:absolute;z-index:3;right:clamp(-520px,-20vw,-245px);bottom:-2.8vh;height:clamp(590px,88vh,1020px);max-width:52vw;object-fit:contain;object-position:right bottom;opacity:.54;transform-origin:78% 100%;transform:scale(var(--oa-skin-scale));filter:brightness(.68) saturate(.78) contrast(.94) drop-shadow(-15px 18px 30px rgba(0,14,25,.24));-webkit-mask-image:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.2) 20%,#000 38%,#000 95%,rgba(0,0,0,.76) 100%);mask-image:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.2) 20%,#000 38%,#000 95%,rgba(0,0,0,.76) 100%)}
      .oa-shell-skin__current{position:absolute;z-index:2;right:-9vw;bottom:-11vh;width:min(72vw,1260px);height:31vh;border-top:1px solid rgba(113,213,235,.17);border-radius:52% 49% 0 0 / 44% 38% 0 0;transform:rotate(-2deg);box-shadow:0 -18px 54px rgba(35,127,164,.06)}
      .oa-shell-skin__current:before{content:"";position:absolute;left:10%;right:-4%;top:28%;height:72%;border-top:1px solid rgba(232,200,121,.11);border-radius:50% 48% 0 0 / 37% 44% 0 0;transform:rotate(3deg)}
      .oa-shell-skin__pearl{position:absolute;z-index:2;width:var(--s);height:var(--s);right:var(--x);top:var(--y);border:1px solid rgba(181,245,255,.2);border-radius:50%;background:radial-gradient(circle at 33% 28%,rgba(255,255,255,.4),rgba(100,220,246,.08) 42%,transparent 72%);box-shadow:0 0 14px rgba(85,213,243,.06);opacity:.5}
      .oa-shell-skin.mode-edge .oa-shell-skin__veil{opacity:.58}.oa-shell-skin.mode-edge .oa-shell-skin__character{right:-25vw;opacity:.48}.oa-shell-skin.mode-edge .oa-shell-skin__atmosphere{right:-5vw;opacity:.25}.oa-shell-skin.mode-edge .oa-shell-skin__edge{right:-185px;opacity:.56}
      .oa-shell-skin.mode-minimal .oa-shell-skin__character{display:none}.oa-shell-skin.mode-minimal .oa-shell-skin__atmosphere{right:-12vw;opacity:.14}.oa-shell-skin.mode-minimal .oa-shell-skin__edge{opacity:.3}.oa-shell-skin.mode-minimal .oa-shell-skin__veil{opacity:.3}.oa-shell-skin.mode-minimal .oa-shell-skin__current{opacity:.35}
      @keyframes oa-whale-breathe{0%,100%{transform:scale(var(--oa-skin-scale)) translate3d(0,0,0) rotate(-.1deg)}50%{transform:scale(var(--oa-skin-scale)) translate3d(-2px,-5px,0) rotate(.08deg)}}
      @keyframes oa-whale-current{0%{transform:translate3d(0,0,0);opacity:.19}100%{transform:translate3d(-12px,-3px,0);opacity:.27}}
      @keyframes oa-whale-pearl{0%{transform:translate3d(0,0,0);opacity:.22}100%{transform:translate3d(-6px,-16px,0);opacity:.54}}
      @media(max-width:1050px){.oa-shell-skin__character{right:-27vw;height:78vh;max-width:58vw;opacity:.48}.oa-shell-skin__atmosphere{right:-8vw;width:90vw}.oa-shell-skin__edge{right:-190px}.oa-shell-skin__current{right:-18vw}}
      @media(max-width:760px){.oa-shell-skin__character{right:-39vw;height:62vh;max-width:76vw;opacity:.42}.oa-shell-skin__atmosphere{right:-18vw;width:104vw;opacity:.2}.oa-shell-skin__edge{right:-240px;opacity:.4}.oa-shell-skin__current{right:-33vw;opacity:.42}.oa-shell-skin__pearl{display:none}.oa-shell-skin__veil{opacity:.4}}
      @media(prefers-reduced-transparency:reduce){.oa-shell-skin__character{opacity:.46}.oa-shell-skin__atmosphere{opacity:.17}}
      @media(prefers-reduced-motion:reduce){.oa-shell-skin *{animation:none!important}}
      .oa-shell-skin.edge-extension-on{-webkit-mask-image:none;mask-image:none}
      .oa-shell-skin.edge-extension-on .oa-shell-skin__character{display:block;right:calc(-1 * var(--oa-edge-outside));bottom:0;width:var(--oa-edge-width);height:var(--oa-edge-height);max-width:none;object-fit:contain;object-position:center center;opacity:1;transform:none;filter:none;-webkit-mask-image:none;mask-image:none;animation:none!important}
      .oa-shell-skin.edge-extension-on .oa-shell-skin__character--inside-tone{z-index:4;filter:brightness(.88) saturate(.96) contrast(.99);-webkit-mask-image:linear-gradient(90deg,#000 0,#000 calc(var(--oa-edge-split-x) - 64px),transparent var(--oa-edge-split-x),transparent 100%),linear-gradient(180deg,transparent 0,transparent var(--oa-edge-split-y),#000 calc(var(--oa-edge-split-y) + 56px),#000 100%);-webkit-mask-composite:source-in;mask-image:linear-gradient(90deg,#000 0,#000 calc(var(--oa-edge-split-x) - 64px),transparent var(--oa-edge-split-x),transparent 100%),linear-gradient(180deg,transparent 0,transparent var(--oa-edge-split-y),#000 calc(var(--oa-edge-split-y) + 56px),#000 100%);mask-composite:intersect}
    `;

    function ShellSkin(props) {
      var skin = props.skin;
      var preferences = props.preferences || {};
      var mood = props.motion.base === "running" ? "focused" : props.motion.base;
      var mode = preferences.skinMode || skin.presentation.defaultMode || "immersive";
      var scale = typeof preferences.skinScale === "number" ? preferences.skinScale : skin.presentation.defaultScale || 1;
      var edgePresentation = props.edgeExtension && props.edgeExtension.presentation;
      var edgeActive = Boolean(props.edgeExtension && props.edgeExtension.running && edgePresentation);
      var edgeRendering = useEdgeGeometry(edgeActive, edgePresentation);
      var edgeGeometry = edgeRendering.geometry;
      var characterStyle = {
        "--oa-edge-width": (edgeActive ? edgeGeometry.width : 1) + "px",
        "--oa-edge-outside": (edgeActive ? edgeGeometry.effectiveOutside : 1) + "px",
        "--oa-edge-height": (edgeActive ? edgeGeometry.height : 1) + "px",
        "--oa-edge-split-x": (edgeActive ? edgeGeometry.hostEdgeX : 1) + "px",
        "--oa-edge-split-y": (edgeActive ? edgeGeometry.hostTopY : 0) + "px",
      };
      var pearls = [
        ["12px", "18vw", "18vh", "7.6s"], ["7px", "31vw", "27vh", "9.1s"], ["18px", "8vw", "36vh", "10.4s"],
        ["9px", "36vw", "52vh", "8.7s"], ["14px", "22vw", "67vh", "11.2s"], ["6px", "43vw", "76vh", "7.9s"],
      ];
      return React.createElement("div", {
        className: "oa-shell-skin mode-" + mode + (skin.presentation.motion ? " motion-on" : " motion-off") + (edgeActive ? " edge-extension-on" : ""),
        "data-mood": mood, "aria-hidden": "true", style: {
          "--oa-skin-scale": scale,
        },
      },
        React.createElement("style", null, skinCss),
        React.createElement("div", { className: "oa-shell-skin__veil" }),
        skin.atmosphereImagePath ? React.createElement("img", { className: "oa-shell-skin__atmosphere", src: assetUrl(props.id, skin.atmosphereImagePath), alt: "", draggable: false }) : null,
        React.createElement("div", { className: "oa-shell-skin__edge" }),
        pearls.map(function (pearl, index) {
          return React.createElement("i", { key: index, className: "oa-shell-skin__pearl", style: { "--s": pearl[0], "--x": pearl[1], "--y": pearl[2], "--d": pearl[3] } });
        }),
        React.createElement("div", { ref: edgeRendering.elementRef, className: "oa-shell-skin__character-plane", style: characterStyle },
          React.createElement("img", { className: "oa-shell-skin__character", src: assetUrl(props.id, skin.characterImagePath), alt: "", draggable: false }),
          edgeActive ? React.createElement("img", { className: "oa-shell-skin__character oa-shell-skin__character--inside-tone", src: assetUrl(props.id, skin.characterImagePath), alt: "", draggable: false }) : null
        ),
        React.createElement("div", { className: "oa-shell-skin__current" })
      );
    }

    function PetPlayer(props) {
      var pet = props.pet;
      var sessions = props.sessions;
      var preferences = props.preferences || {};
      var frame = pet.frame;
      var columns = frame.columns;
      var rows = frame.rows;
      var pixelRatio = frame.pixelRatio || 1;
      var cellWidth = frame.width / columns / pixelRatio;
      var cellHeight = frame.height / rows / pixelRatio;
      var scale = typeof preferences.scale === "number" ? preferences.scale : 1.35;
      var renderedWidth = cellWidth * scale;
      var renderedHeight = cellHeight * scale;
      var sheet = assetUrl(pet.id, pet.spritesheetPath);

      var animState = useState("idle");
      var animation = animState[0];
      var setAnimation = animState[1];
      var frameState = useState(0);
      var frameOffset = frameState[0];
      var setFrameOffset = frameState[1];
      var baseRef = useRef("idle");
      var animationRef = useRef(animation);
      animationRef.current = animation;
      var interaction = useRef(false);
      var pendingCues = useRef([]);
      useEffect(function () {
        var motion = props.motion;
        baseRef.current = motion.base;
        if (motion.base !== "idle") pendingCues.current = pendingCues.current.filter(function (cue) { return cue !== "review"; });
        if (props.native) {
          post("/api/openadam-companions/pet-state", {
            base: motion.base, cue: motion.cue, eventID: motion.eventID,
          }, false).then(function () {
            if (motion.cue) motion.acknowledge(motion.eventID);
          }).catch(function () {});
          return;
        }
        if (motion.cue) {
          if (interaction.current || !["idle", "running", "waiting"].includes(animationRef.current)) {
            pendingCues.current.push(motion.cue);
            if (pendingCues.current.length > 16) pendingCues.current.shift();
          }
          else setAnimation(motion.cue);
          motion.acknowledge(motion.eventID);
        } else if (!interaction.current && (["idle", "running", "waiting"].includes(animationRef.current) ||
                   (animationRef.current === "review" && motion.base !== "idle"))) {
          setAnimation(motion.base);
        }
      }, [props.motion.base, props.motion.cue, props.motion.eventID, props.native]);
      useEffect(function () { setFrameOffset(0); }, [animation]);
      var frames = useMemo(function () { return animationFrames(pet, animation); }, [pet, animation]);
      useEffect(function () {
        if (props.native) return;
        var current = frames[frameOffset % frames.length];
        var timer = setTimeout(function () {
          if (frameOffset + 1 < frames.length) { setFrameOffset(frameOffset + 1); return; }
          var spec = pet.animations[animation] || pet.animations.idle;
          if (spec.loop) setFrameOffset(0);
          else {
            var queuedCue = pendingCues.current.shift();
            setAnimation(queuedCue || baseRef.current);
          }
        }, current[1]);
        return function () { clearTimeout(timer); };
      }, [frames, frameOffset, animation, pet, props.native]);

      var currentFrame = frames[frameOffset % frames.length][0];
      var column = currentFrame % columns;
      var row = Math.floor(currentFrame / columns);
      var positionState = useState(function () {
        try {
          var value = JSON.parse(localStorage.getItem("openadam-companion:position") || "null");
          if (value && typeof value.x === "number" && typeof value.y === "number") return value;
        } catch (_) {}
        return { x: null, y: null };
      });
      var position = positionState[0];
      var setPosition = positionState[1];
      var petRef = useRef(null);
      var drag = useRef(null);
      var moved = useRef(false);

      useEffect(function () {
        if (props.native) return;
        function clamp(x, y) {
          return {
            x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - renderedWidth)),
            y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - renderedHeight)),
          };
        }
        function inside(bounds, event) {
          return event.clientX >= bounds.left && event.clientX <= bounds.right &&
            event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        }
        function pointerDown(event) {
          var element = petRef.current;
          if (!element || event.button !== 0 || drag.current) return;
          var bounds = element.getBoundingClientRect();
          if (!inside(bounds, event)) return;
          event.preventDefault();
          event.stopPropagation();
          drag.current = {
            pointerId: event.pointerId, sx: event.clientX, sy: event.clientY,
            originX: bounds.left, originY: bounds.top, lx: event.clientX,
            latest: { x: bounds.left, y: bounds.top },
          };
          moved.current = false;
          interaction.current = true;
          pendingCues.current = [];
          try { element.setPointerCapture && element.setPointerCapture(event.pointerId); } catch (_) {}
          document.documentElement.style.cursor = "grabbing";
        }
        function pointerMove(event) {
          var value = drag.current;
          var element = petRef.current;
          if (!value || !element || event.pointerId !== value.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          var distanceX = event.clientX - value.sx;
          var distanceY = event.clientY - value.sy;
          if (!moved.current && isDeliberateDrag(distanceX, distanceY)) {
            moved.current = true;
            setAnimation(pet.presentation.dragAnimation || "running-right");
          }
          if (!moved.current) return;
          var deltaX = event.clientX - value.lx;
          if (moved.current && Math.abs(deltaX) > 6) {
            var directionalDrag = deltaX < 0 ? "running-left" : "running-right";
            if (pet.animations[directionalDrag] && animationRef.current !== directionalDrag) setAnimation(directionalDrag);
            value.lx = event.clientX;
          }
          var next = clamp(value.originX + distanceX, value.originY + distanceY);
          value.latest = next;
          element.style.transform = "translate3d(" + (next.x - value.originX) + "px," + (next.y - value.originY) + "px,0)";
        }
        function finish(event) {
          var value = drag.current;
          var element = petRef.current;
          if (!value || (event.pointerId != null && event.pointerId !== value.pointerId)) return;
          event.preventDefault();
          event.stopPropagation();
          var cancelled = event.type === "pointercancel" || event.type === "blur";
          var release = dragRelease(value, moved.current, cancelled);
          var next = release.position;
          drag.current = null;
          if (element) {
            try { element.releasePointerCapture && element.releasePointerCapture(value.pointerId); } catch (_) {}
            element.style.left = next.x + "px";
            element.style.top = next.y + "px";
            element.style.right = "auto";
            element.style.bottom = "auto";
            element.style.transform = "";
          }
          document.documentElement.style.cursor = "";
          if (release.persist) {
            setPosition(next);
            try { localStorage.setItem("openadam-companion:position", JSON.stringify(next)); } catch (_) {}
          }
          interaction.current = false;
          setAnimation(pendingCues.current.shift() || (!cancelled && !moved.current && pet.animations.waving ? "waving" : baseRef.current));
        }
        function resize() {
          if (drag.current || position.x == null || position.y == null) return;
          var next = clamp(position.x, position.y);
          if (next.x === position.x && next.y === position.y) return;
          setPosition(next);
          try { localStorage.setItem("openadam-companion:position", JSON.stringify(next)); } catch (_) {}
        }
        window.addEventListener("pointerdown", pointerDown, true);
        window.addEventListener("pointermove", pointerMove, true);
        window.addEventListener("pointerup", finish, true);
        window.addEventListener("pointercancel", finish, true);
        window.addEventListener("blur", finish, true);
        window.addEventListener("resize", resize, { passive: true });
        return function () {
          interaction.current = false;
          drag.current = null;
          window.removeEventListener("pointerdown", pointerDown, true);
          window.removeEventListener("pointermove", pointerMove, true);
          window.removeEventListener("pointerup", finish, true);
          window.removeEventListener("pointercancel", finish, true);
          window.removeEventListener("blur", finish, true);
          window.removeEventListener("resize", resize);
          document.documentElement.style.cursor = "";
        };
      }, [pet, renderedWidth, renderedHeight, position.x, position.y, props.native]);

      var style = {
        position: "fixed", zIndex: 80,
        left: position.x == null ? "auto" : position.x,
        right: position.x == null ? 24 : "auto",
        top: position.y == null ? "auto" : position.y,
        bottom: position.y == null ? 24 : "auto",
        width: renderedWidth, height: renderedHeight,
        backgroundImage: "url(" + sheet + ")",
        backgroundSize: (frame.width / pixelRatio * scale) + "px " + (frame.height / pixelRatio * scale) + "px",
        backgroundPosition: (-column * renderedWidth) + "px " + (-row * renderedHeight) + "px",
        backgroundRepeat: "no-repeat",
        imageRendering: "auto", filter: "drop-shadow(0 10px 16px rgba(4, 31, 49, 0.20))",
        cursor: drag.current ? "grabbing" : "grab", touchAction: "none", userSelect: "none",
        pointerEvents: "auto", willChange: "transform, background-position", contain: "layout paint",
        display: props.native ? "none" : "block",
      };
      return React.createElement("div", {
        ref: petRef,
        style: style, role: "img", "aria-label": pet.displayName,
        title: pet.displayName + " · 可自由拖动，左右拖动会按方向被拎起来",
      });
    }

    function CompanionOverlay(props) {
      var statePair = useState(null);
      var state = statePair[0];
      var setState = statePair[1];
      var cueEnabled = Boolean(state && state.active && state.preferences && state.preferences.petEnabled);
      var motion = useSessionMotion(props.sessions, cueEnabled);
      var refresh = useCallback(function () {
        return stateRequest().then(setState).catch(function () { setState(null); });
      }, []);
      useEffect(function () { refresh(); return onChanged(refresh); }, [refresh]);
      var edgeExtensionEnabled = Boolean(state && state.preferences && state.preferences.edgeExtensionEnabled);
      useEdgeHostFrameStream(
        Boolean(edgeExtensionEnabled && state && state.preferences.skinEnabled),
        state && state.edgeExtension && state.edgeExtension.presentation
      );
      useEffect(function () {
        if (!edgeExtensionEnabled && !(state && state.preferences && state.preferences.petEnabled)) return;
        var timer = setInterval(refresh, 2500);
        return function () { clearInterval(timer); };
      }, [refresh, edgeExtensionEnabled, state && state.preferences && state.preferences.petEnabled]);
      if (!state || !state.active) return null;
      var skin = state.active.companion && state.active.companion.skin;
      return React.createElement(React.Fragment, null,
        skin && state.preferences.skinEnabled
          ? React.createElement(ShellSkin, { id: state.active.id, skin: skin, preferences: state.preferences, edgeExtension: state.edgeExtension, motion: motion })
          : null,
        state.preferences.petEnabled
          ? React.createElement(PetPlayer, { pet: state.active, preferences: state.preferences, motion: motion,
              native: Boolean(state.edgeExtension && state.edgeExtension.nativePetRunning) })
          : null
      );
    }

    var buttonStyle = {
      border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8,
      background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)",
      padding: "7px 11px", cursor: "pointer", fontSize: 12,
    };
    var cardStyle = {
      border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12,
      background: "var(--dsw-alias-bg-layer-1)", padding: 12, marginBottom: 10,
    };

    function CompanionSettings() {
      var statePair = useState(null);
      var state = statePair[0];
      var setState = statePair[1];
      var errorPair = useState("");
      var error = errorPair[0];
      var setError = errorPair[1];
      var busyPair = useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var input = useRef(null);
      var timer = useRef(null);
      var refresh = useCallback(function () {
        return stateRequest().then(function (next) { setState(next); setError(""); })
          .catch(function (reason) { setError(reason.message || String(reason)); });
      }, []);
      useEffect(function () { refresh(); return onChanged(refresh); }, [refresh]);
      useEffect(function () { return function () { if (timer.current) clearTimeout(timer.current); }; }, []);
      var edgeExtensionEnabled = Boolean(state && state.preferences && state.preferences.edgeExtensionEnabled);
      useEffect(function () {
        if (!edgeExtensionEnabled) return;
        var statusTimer = setInterval(refresh, 2500);
        return function () { clearInterval(statusTimer); };
      }, [refresh, edgeExtensionEnabled]);

      function perform(action) {
        setBusy(true); setError("");
        return action.then(function () { return refresh(); })
          .catch(function (reason) { setError(reason.message || String(reason)); })
          .then(function () { setBusy(false); });
      }
      function upload(event) {
        var file = event.target.files && event.target.files[0];
        if (!file) return;
        perform(file.arrayBuffer().then(function (bytes) {
          return post("/api/openadam-companions/upload", bytes, true);
        }));
        event.target.value = "";
      }
      function preference(patch) {
        return perform(post("/api/openadam-companions/preferences", patch, false));
      }
      if (!state) return React.createElement("div", null, error || "正在读取伙伴胶囊…");
      var preferences = state.preferences;
      var companions = state.companions || [];
      var active = state.active;
      var rows = companions.map(function (companion) {
        var selected = active && active.id === companion.id;
        var capsule = companion.companion && companion.companion.capsule;
        return React.createElement("div", { key: companion.id, style: cardStyle },
          React.createElement("div", { style: { display: "flex", gap: 12, alignItems: "center" } },
            companion.companion && companion.companion.skin
              ? React.createElement("div", { style: { width: 56, height: 64, borderRadius: "18px 5px 18px 5px",
                  background: "linear-gradient(145deg,#0b2b43,#176f9b)", overflow: "hidden", flex: "none", position: "relative" } },
                  React.createElement("img", { src: assetUrl(companion.id, companion.companion.skin.characterImagePath), alt: "",
                    style: { width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 13%", transform: "scale(1.45)", transformOrigin: "50% 13%" } }))
              : React.createElement("div", {
                  style: { width: 56, height: 56, borderRadius: 10, backgroundImage: "url(" + assetUrl(companion.id, companion.spritesheetPath) + ")",
                           backgroundSize: companion.frame.width / (192 / 56) + "px " + companion.frame.height / (192 / 56) + "px",
                           backgroundPosition: "0 0", backgroundRepeat: "no-repeat", flex: "none" },
                }),
            React.createElement("div", { style: { flex: 1, minWidth: 0 } },
              React.createElement("div", { style: { fontWeight: 650, color: "var(--dsw-alias-label-primary)" } }, companion.displayName),
              React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)", marginTop: 3 } },
                companion.companion.release + " · " + Math.round(companion.assetBytes / 1024) + " KB"),
              React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)", marginTop: 3 } },
                capsule ? (capsule.policy === "fork-only" ? "含存档 · 仅允许分叉" : "含存档 · 可恢复或分叉") : "出生起点 · DSH 仅显示，不创建身份")
            ),
            selected
              ? React.createElement("span", { style: { color: "var(--dsw-alias-state-success-primary)", fontSize: 12, fontWeight: 650 } }, "使用中")
              : React.createElement("button", { style: buttonStyle, disabled: busy,
                  onClick: function () { preference({ active: companion.id, petEnabled: true }); } }, "使用"),
            React.createElement("button", { style: buttonStyle, disabled: busy,
              onClick: function () {
                if (window.confirm("移除组合包“" + companion.displayName + "”？本操作不会删除原 zip。")) {
                  perform(post("/api/openadam-companions/remove", { id: companion.id }, false));
                }
              } }, "移除")
          )
        );
      });
      return React.createElement("div", { style: { padding: "2px 0 12px" } },
        React.createElement("div", { style: { marginBottom: 12, color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: 1.6 } },
          "组合包包含桌宠身体、Shell 皮肤、主题及可选存档。DSH 负责显示；可选存档原样保留，需要兼容的运行时才能打开或恢复。"),
        React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 12 } },
          React.createElement("button", { style: buttonStyle, disabled: busy, onClick: function () { input.current && input.current.click(); } }, "导入 .companion.zip"),
          React.createElement("input", { ref: input, type: "file", accept: ".zip,.companion.zip", style: { display: "none" }, onChange: upload }),
          error ? React.createElement("span", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, error) : null
        ),
        active ? React.createElement("div", { style: cardStyle },
          React.createElement("div", { style: { display: "grid", gap: 10 } },
            active.companion && active.companion.appearances && active.companion.appearances.length > 1
              ? React.createElement("div", { style: { display: "grid", gap: 7 } },
                  React.createElement("div", { style: { fontSize: 12, fontWeight: 650, color: "var(--dsw-alias-label-primary)" } }, "装扮"),
                  React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(118px,1fr))", gap: 8 } },
                    active.companion.appearances.map(function (appearance) {
                      var selected = preferences.appearanceId === appearance.id;
                      var body = appearance.body;
                      return React.createElement("button", {
                        key: appearance.id,
                        type: "button",
                        disabled: busy,
                        "aria-pressed": selected,
                        onClick: function () { preference({ appearanceId: appearance.id }); },
                        style: {
                          display: "grid", gridTemplateColumns: "42px 1fr", alignItems: "center", gap: 8,
                          minHeight: 54, padding: 6, textAlign: "left", cursor: busy ? "wait" : "pointer",
                          borderRadius: 10, color: "var(--dsw-alias-label-primary)",
                          border: selected ? "1px solid var(--dsw-alias-brand-primary)" : "1px solid var(--dsw-alias-border-l1)",
                          background: "var(--dsw-alias-bg-layer-2)",
                          boxShadow: selected ? "inset 0 0 0 1px var(--dsw-alias-brand-primary)" : "none",
                        },
                      },
                        appearance.skin
                          ? React.createElement("img", { src: assetUrl(active.id, appearance.skin.characterImagePath), alt: "",
                              style: { width: 42, height: 42, borderRadius: 9, objectFit: "cover", objectPosition: "50% 14%", background: "var(--dsw-alias-bg-layer-1)" } })
                          : React.createElement("span", { style: {
                              width: 42, height: 42, borderRadius: 9, display: "block",
                              backgroundImage: "url(" + assetUrl(active.id, body.spritesheetPath) + ")",
                              backgroundSize: body.frame.width / (192 / 42) + "px " + body.frame.height / (192 / 42) + "px",
                              backgroundPosition: "0 0", backgroundRepeat: "no-repeat",
                            } }),
                        React.createElement("span", { style: { minWidth: 0 } },
                          React.createElement("span", { style: { display: "block", fontSize: 12, fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, appearance.name),
                          React.createElement("small", { style: { display: "block", marginTop: 2, color: "var(--dsw-alias-label-secondary)" } }, selected ? "使用中" : "切换")
                        )
                      );
                    })
                  )
                )
              : null,
            active.companion && active.companion.skin ? React.createElement("label", { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } },
              React.createElement("span", null, "显示“" + active.companion.skin.name + "”完整皮肤"),
              React.createElement("input", { type: "checkbox", checked: preferences.skinEnabled,
                onChange: function (event) { preference({ skinEnabled: event.target.checked }); } })
            ) : null,
            active.companion && active.companion.skin && state.edgeExtension && state.edgeExtension.available ? React.createElement("label", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, fontSize: 12 } },
              React.createElement("span", null, "角色越过 DSH 右边框", React.createElement("small", { style: { display: "block", color: "var(--dsw-alias-label-secondary)", marginTop: 2 } }, "窗口内渐隐，边框外保持原始透明度")),
              React.createElement("input", { type: "checkbox", checked: preferences.edgeExtensionEnabled === true,
                onChange: function (event) { preference({ edgeExtensionEnabled: event.target.checked }); } })
            ) : null,
            preferences.edgeExtensionEnabled && state.edgeExtension && !state.edgeExtension.running ? React.createElement("div", {
              style: { color: "var(--dsw-alias-state-warn-primary)", fontSize: 11, lineHeight: 1.5 },
            }, state.edgeExtension.error || "窗口外延未运行，当前已回退为 DSH 窗口内显示。关闭再打开可重试。") : null,
            React.createElement("label", { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } },
              React.createElement("span", null,
                state.edgeExtension && state.edgeExtension.available
                  ? (active.companion && active.companion.skin ? "显示独立 Q 版桌宠" : "显示独立桌宠")
                  : (active.companion && active.companion.skin ? "显示 Q 版伙伴" : "显示伙伴身体")),
              React.createElement("input", { type: "checkbox", checked: preferences.petEnabled,
                onChange: function (event) { preference({ petEnabled: event.target.checked }); } })
            ),
            active.companion && active.companion.theme ? React.createElement("label", { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } },
              React.createElement("span", null, "应用“" + active.companion.theme.name + "”主题"),
              React.createElement("input", { type: "checkbox", checked: preferences.themeEnabled,
                onChange: function (event) { preference({ themeEnabled: event.target.checked }); } })
            ) : null,
            active.companion && active.companion.skin ? React.createElement("label", { style: { display: "grid", gridTemplateColumns: "72px 1fr", alignItems: "center", gap: 8, fontSize: 12 } },
              React.createElement("span", null, "皮肤布局"),
              React.createElement("select", { value: preferences.skinMode, disabled: busy,
                style: { ...buttonStyle, width: "100%" }, onChange: function (event) { preference({ skinMode: event.target.value }); } },
                React.createElement("option", { value: "immersive" }, "完整舞台"),
                React.createElement("option", { value: "edge" }, "角色靠边"),
                React.createElement("option", { value: "minimal" }, "静默纹理"))
            ) : null,
            active.companion && active.companion.skin ? React.createElement("label", { style: { display: "grid", gridTemplateColumns: "72px 1fr 48px", alignItems: "center", gap: 8, fontSize: 12 } },
              React.createElement("span", null, "角色大小"),
              React.createElement("input", { type: "range", min: 80, max: 130, step: 5, value: Math.round(preferences.skinScale * 100),
                onChange: function (event) {
                  var skinScale = Number(event.target.value) / 100;
                  setState({ ...state, preferences: { ...preferences, skinScale: skinScale } });
                  if (timer.current) clearTimeout(timer.current);
                  timer.current = setTimeout(function () { post("/api/openadam-companions/preferences", { skinScale: skinScale }, false).catch(function (reason) { setError(reason.message); }); }, 250);
                } }),
              React.createElement("span", { style: { textAlign: "right", color: "var(--dsw-alias-label-secondary)" } }, Math.round(preferences.skinScale * 100) + "%")
            ) : null,
            preferences.petEnabled ? React.createElement("label", { style: { display: "grid", gridTemplateColumns: "72px 1fr 48px", alignItems: "center", gap: 8, fontSize: 12 } },
              React.createElement("span", null, "宠物大小"),
              React.createElement("input", { type: "range", min: 75, max: 225, step: 5, value: Math.round(preferences.scale * 100),
                onChange: function (event) {
                  var scale = Number(event.target.value) / 100;
                  setState({ ...state, preferences: { ...preferences, scale: scale } });
                  if (timer.current) clearTimeout(timer.current);
                  timer.current = setTimeout(function () { post("/api/openadam-companions/preferences", { scale: scale }, false).catch(function (reason) { setError(reason.message); }); }, 250);
                } }),
              React.createElement("span", { style: { textAlign: "right", color: "var(--dsw-alias-label-secondary)" } }, Math.round(preferences.scale * 100) + "%")
            ) : null
          )
        ) : null,
        rows.length ? rows : React.createElement("div", { style: { ...cardStyle, color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, "还没有组合包。导入后可分别开关桌宠身体、Shell 皮肤与主题。")
      );
    }

    var inject = ["slots", "sessions", "theme"];
    function apply(ctx) {
      var sessions = null;
      try { sessions = ctx.get("sessions"); } catch (_) {}

      ctx.effect(function () {
        return ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register(
            { name: "shell.overlay", id: "openadam-blue-fat-fish", order: 100,
              label: "蓝色大肥鱼 · OpenAdam 版", inject: function () { return { sessions: sessions }; } },
            CompanionOverlay
          );
        });
      }, "openadam-blue-fat-fish: shell overlay");

      ctx.effect(function () {
        return ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            { name: "settings.section", id: "openadam-blue-fat-fish", order: 90, label: function () { return "蓝色大肥鱼"; } },
            CompanionSettings
          );
        });
      }, "openadam-blue-fat-fish: settings");

      ctx.effect(function () {
        var disposeTheme = null;
        var cancelled = false;
        function sync() {
          stateRequest().then(function (state) {
            if (cancelled) return;
            if (disposeTheme) { disposeTheme(); disposeTheme = null; }
            var theme = state.active && state.active.companion && state.active.companion.theme;
            if (theme && state.preferences.themeEnabled) {
              disposeTheme = ctx.theme.overrideTokens("openadam-blue-fat-fish", paletteTokens(theme));
            }
          }).catch(function () {});
        }
        sync();
        var off = onChanged(sync);
        return function () { cancelled = true; off(); if (disposeTheme) disposeTheme(); };
      }, "openadam-blue-fat-fish: theme override");
    }

    exports.createSessionMotion = createSessionMotion;
    exports.createMotionInbox = createMotionInbox;
    exports.isDeliberateDrag = isDeliberateDrag;
    exports.dragRelease = dragRelease;
    exports.edgeHostFrameDelay = edgeHostFrameDelay;
    exports.isMaximizedHostFrame = isMaximizedHostFrame;
    exports.measureEdgeGeometry = measureEdgeGeometry;
    exports.normalizeEdgeGeometry = normalizeEdgeGeometry;
    exports.edgeGeometryKey = edgeGeometryKey;
    exports.chooseEdgeGeometryFrame = chooseEdgeGeometryFrame;
    exports.applyEdgeGeometry = applyEdgeGeometry;
    exports.isRuntimeStatePost = isRuntimeStatePost;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
