# 蓝色大肥鱼 · OpenAdam 版

This unofficial community DSH market plugin installs Blue Fat Fish's visual
body and skin in DSH. It renders her animated body or responsive Shell skin in the public
`shell.overlay` slot, provides a `settings.section` management surface, and
applies the bundled declarative palette through DSH's official
`theme.overrideTokens` API. This display adapter does not create a persistent
identity, memory, or a separate macOS desktop app.

The market package contains executable adapter code and one separately licensed,
data-only Companion Bundle. The bundle cannot add JavaScript, change DSH
configuration, or grant Agent permissions. The importer checks ZIP metadata
before decompression, rejects links and path traversal, verifies every declared
SHA-256 digest, and writes through a temporary folder. Users may still import
other compatible `.companion.zip` files manually.

## Current scope

- Body: the fixed Codex/Petdex v2 atlas remains supported at its required
  192×208 physical cell size. DSH can additionally use an
  `openadam.desktop-pet.v1` atlas with the same 192×208 logical cell and a
  declared 1×–4× pixel ratio. The blue-whale editing master remains 4×; its DSH
  fallback is packaged at 2.5× (480×520 pixels per cell), enough for the default
  120% presentation on a 2× display without upscaling.
- Shell skin: `openadam.shell-skin` manifest plus a validated 768×1024 or larger
  PNG/WebP character plate and an optional validated atmosphere plate. The host
  draws the responsive stage, soft edge treatment, status treatment and motion;
  the bundle remains data-only.
- Theme: `openadam.shell-theme` semantic light/dark palette.
- Capsule: retained byte-for-byte with its manifest policy. DSH does not open
  it. Creating or restoring an identity requires a compatible capsule runtime.
- Interaction: the Q-style body and full Shell skin both appear after market
  installation; 120% default pet size, 75–225% user scale, no hover shrink,
  click to wave, and direction-aware left/right lifted poses throughout a drag
  gesture. Waiting, work, completion, and newly failed jobs are projected
  separately: after a local wave or drag,
  the body resumes the current host state instead of always falling back to
  idle. Pointer jitter stays a click, while cancellation rolls an active drag
  preview back without saving it. Later bundle updates preserve the user's body
  and skin switches.
- Skin controls: full stage, edge character, or quiet texture; independent
  80–130% character scale and separate body/theme switches. Reduced-motion
  preferences disable decorative movement automatically.
- Appearances: a bundle may declare up to 16 named appearances. Each appearance
  atomically selects one complete DSH body, its matching Shell character skin,
  and an optional theme. DSH remembers the selection per companion and only
  shows the compact **装扮** chooser when at least two complete appearances are
  present; body and skin cannot be switched into a mismatched combination.
- Replaceable bodies: an existing sprite body may declare one optional
  `openadam.body-renderer.v1` projection. The importer admits only a closed,
  hash-verified Model3 resource graph; the external renderer must complete a
  versioned handshake before it replaces the sprite body. Missing, incompatible,
  timed-out, or crashed renderers fall back to the existing sprite/APNG body
  without changing the selected companion or appearance. The process contract
  is documented in `docs/BODY-RENDERER-CONTRACT.md`; this adapter does not bundle
  the Live2D Cubism SDK.
- Public carrier: the DSH market package uses the portable in-DSH renderer and
  contains no native application or macOS helper. `edgeHelperExecutable` remains
  an explicit local development override and is not part of the market payload.

## Local install

```sh
npm run candidate
npm pack
dsh plugin --profile web add ./openadam-blue-fat-fish-0.2.30.tgz
dsh --profile web
```

`npm run candidate` validates the adapter and exact Blue Fat Fish archive,
uses the bundled archive by default, and audits the npm files and nested bundle.
To replace the archive during development, explicitly set
`OPENADAM_BLUE_FAT_FISH_BUNDLE` to the new archive path. Installing that one
package makes Blue Fat Fish available automatically on an empty profile. Open
**Settings → 蓝色大肥鱼** to change her body, Shell skin or theme, or to import another
compatible bundle. Removing an imported bundle never deletes the original zip.

An optional top-level `appearances` array in `companion.json` binds the already
declared resources without adding executable code:

```json
{
  "appearances": [
    {
      "id": "default-maid",
      "name": "深海女仆",
      "bodyId": "studio.openadam.blue-whale-maid.dsh",
      "skinId": "studio.openadam.blue-whale-maid.atelier",
      "themeId": "studio.openadam.blue-whale-maid.shell",
      "default": true
    },
    {
      "id": "claude-disguise",
      "name": "Claude 伪装",
      "bodyId": "studio.openadam.blue-whale-maid.claude.dsh",
      "skinId": "studio.openadam.blue-whale-maid.claude.skin",
      "themeId": "studio.openadam.blue-whale-maid.shell"
    }
  ]
}
```

Every referenced body, skin and theme must independently pass the existing
resource, dimensions, hash and host checks. Bundles without `appearances` keep
their previous one-body/one-skin behavior.

An independently installed compatible body renderer can be selected by setting
`OPENADAM_BODY_RENDERER` to its executable path before the DSH Desktop profile
starts. Ordinary users do not need this setting for sprite bodies. The renderer
is trusted executable code and therefore remains separate from data-only
Companion Bundles.

The default bundle ceiling is 96 MB so a Companion can retain its complete
sprite fallback while carrying one validated richer-body projection. Import is
still bounded to 256 archive entries and 128 declared resources; every file is
hash-checked and no single resource may exceed 64 MB. Operators may lower the
overall ceiling with `maxUploadBytes`.

The adapter is licensed under Apache License 2.0; see `LICENSE`. Adapted MIT
portions retain their original license in `third_party/`. The bundled companion
artwork remains separately licensed under the attribution and CC BY-NC-SA 4.0
terms recorded inside `dist/blue-fat-fish.companion.zip` and summarized in
`THIRD_PARTY_NOTICES.md`.

## Source export

`public-source-files.json` lists the source inputs. To create a source directory
with the bundled artwork and build tools, choose a new output directory:

```sh
npm run source:export -- --output /path/to/blue-fat-fish-source
```

From that directory, `npm run candidate` and `npm pack` rebuild the market
package without an adjacent asset checkout. The macOS helper source is available
under `native/macos/` for development and remains separate from the market package.
