# External body renderer contract v1

`openadam.body-renderer.v1` is the DSH Companion adapter boundary for a trusted native process that renders a richer body while preserving the existing sprite body as a complete fallback. The contract is renderer-neutral at the process boundary. The first admitted model projection is `live2d.cubism.model3.v1`.

The DSH adapter does not contain or redistribute Live2D Cubism SDK code. A renderer distributor is responsible for the renderer implementation, model rights, required notices and any applicable Live2D publication agreement. Official model structure and release-license information are maintained at:

- https://docs.live2d.com/en/cubism-sdk-manual/model-web/
- https://www.live2d.com/en/sdk/license/

## Bundle declaration

A normal DSH body remains required and owns the fallback sprite/APNG animations. It may add one projection:

```json
{
  "id": "studio.example.companion.dsh",
  "format": "openadam.desktop-pet.v1",
  "hosts": ["dsh"],
  "manifestRole": "dsh-pet-manifest",
  "spritesheetRole": "dsh-pet-spritesheet",
  "nativeSequenceRole": "dsh-pet-native-sequence",
  "projection": {
    "contract": "openadam.body-renderer.v1",
    "format": "live2d.cubism.model3.v1",
    "entryRole": "live2d-model3",
    "assetRoles": [
      "live2d-moc3",
      "live2d-texture-00",
      "live2d-physics3",
      "live2d-motion-idle"
    ]
  }
}
```

Every role must point to a resource in `being-definition.json` with its exact byte count and SHA-256. `entryRole` must be a Version 3 `.model3.json`. The importer resolves its model, texture, physics, pose, display-info, user-data, expression, motion and motion-sound references relative to that file. The resolved reference set must equal `assetRoles` exactly. Absolute paths, parent traversal, undeclared files, executable files and partial graphs are rejected before installation.

The current data allowlist admits JSON, PNG/JPEG/WebP textures and `.moc3` model data. A new media type requires an adapter update and validation; a renderer cannot expand the allowlist.

## Process launch

The host launches the executable directly, without a shell:

```text
renderer \
  --contract openadam.body-renderer.v1 \
  --format live2d.cubism.model3.v1 \
  --entry /absolute/installed/model.model3.json \
  --scale 1.2 \
  --parent-pid 12345
```

The entry file and everything it can reference have already passed the bundle integrity check. The renderer must not search outside the entry file's declared graph. It owns its transparent desktop window, pointer interaction, local wave/drag performances, frame timing and model-specific physics. It must exit when the parent process exits.

Only `HOME`, `TMPDIR`, `LANG` and `LC_ALL` are inherited when present. No DSH credentials, model-provider keys or workspace variables are intentionally forwarded.

## Handshake and state

Within five seconds, stdout must emit one JSON line:

```json
{"kind":"ready","contract":"openadam.body-renderer.v1","format":"live2d.cubism.model3.v1"}
```

Until that exact handshake arrives, DSH keeps the existing sprite/APNG body visible. After readiness, stdin receives newline-delimited state messages:

```json
{"kind":"pet-state","base":"running","cue":null,"eventID":null}
{"kind":"pet-state","base":"idle","cue":"review","eventID":"review-42"}
```

`base` is `idle`, `running` or `waiting`. `cue` is absent/null or a one-shot `failed`/`review` performance. A non-null cue always has an event ID and a renderer must not replay the same event ID. Backpressure may coalesce base state to the newest value, while accepted one-shot cues remain ordered.

## Failure and switching

An invalid handshake, timeout, spawn failure or process exit disables that exact executable/model selection for the current run and immediately restores the fallback sprite body. It is not crash-looped. Changing the selected appearance, renderer path or model produces a new selection and permits a fresh attempt. Disabling the body terminates the renderer.

Appearance selection stays atomic: the same appearance still owns its body fallback, optional richer projection, skin and theme. A renderer failure never switches identity, outfit, skin or theme.
