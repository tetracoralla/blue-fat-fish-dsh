#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
package_root="$repo_root/native/macos"
dist_root="$repo_root/dist"
app_root="$dist_root/DSHEdgeCompanion.app"
binary_name="DSHEdgeCompanion"
package_version="$(node -p 'require(process.argv[1]).version' "$repo_root/package.json")"
distribution_build="${OPENADAM_DISTRIBUTION_BUILD:-0}"
signing_identity="${OPENADAM_CODESIGN_IDENTITY:--}"
notary_profile="${OPENADAM_NOTARY_PROFILE:-}"

if [[ ! "$package_version" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
  echo "Invalid package version for app bundle: $package_version" >&2
  exit 1
fi
if [[ "$distribution_build" != "0" && "$distribution_build" != "1" ]]; then
  echo "OPENADAM_DISTRIBUTION_BUILD must be 0 or 1" >&2
  exit 1
fi
if [[ "$distribution_build" == "1" && "$signing_identity" == "-" ]]; then
  echo "Distribution builds require OPENADAM_CODESIGN_IDENTITY with a Developer ID Application identity" >&2
  exit 1
fi
if [[ "$distribution_build" == "1" && -z "$notary_profile" ]]; then
  echo "Distribution builds require OPENADAM_NOTARY_PROFILE for notarytool" >&2
  exit 1
fi
if [[ -n "$notary_profile" && "$signing_identity" == "-" ]]; then
  echo "Notarization cannot be used with an ad-hoc signature" >&2
  exit 1
fi

swift build --package-path "$package_root" -c release --product "$binary_name"
binary_path="$(swift build --package-path "$package_root" -c release --show-bin-path)/$binary_name"

rm -rf "$app_root"
mkdir -p "$app_root/Contents/MacOS"
cp "$binary_path" "$app_root/Contents/MacOS/$binary_name"
strip -S -x "$app_root/Contents/MacOS/$binary_name"
chmod 755 "$app_root/Contents/MacOS/$binary_name"
cat > "$app_root/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>DSHEdgeCompanion</string>
  <key>CFBundleIdentifier</key><string>studio.openadam.dsh-edge-companion</string>
  <key>CFBundleName</key><string>DSH Edge Companion</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${package_version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

if [[ "$signing_identity" == "-" ]]; then
  codesign --force --sign - "$app_root"
else
  codesign --force --options runtime --timestamp --sign "$signing_identity" "$app_root"
fi
codesign --verify --deep --strict --verbose=2 "$app_root"

if [[ -n "$notary_profile" ]]; then
  notarization_dir="$(mktemp -d)"
  trap 'rm -rf "$notarization_dir"' EXIT
  notarization_archive="$notarization_dir/DSHEdgeCompanion.zip"
  ditto -c -k --keepParent "$app_root" "$notarization_archive"
  xcrun notarytool submit "$notarization_archive" --keychain-profile "$notary_profile" --wait
  xcrun stapler staple "$app_root"
  xcrun stapler validate "$app_root"
fi

if [[ "$distribution_build" == "1" ]]; then
  spctl -a -vv --type execute "$app_root"
fi

echo "$app_root"
