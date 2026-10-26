import { DEFAULT_MAX_BUNDLE_BYTES, inspectZipContainer, validateCompanionEntries } from "../lib/pet-library.js";
import { unzipSync } from "../lib/vendor/fflate.mjs";

const privatePath = /(?:^|\/)(?:\.local|research|\.task-notes|\.git)(?:\/|$)|(?:^|\/)(?:WORKING|PROVENANCE|request-brief)\.md$|(?:^|\/)pet-record\.json$/i;
const privateText = /\/Users\/[^/\s"'<>]+\/|\/Volumes\/[^/\r\n]+\/|\/(?:private\/)?var\/folders\/|(?:owner|user) (?:explicitly )?(?:said|confirmed|requested|approved)|(?:用户|所有者)(?:原话|明确要求|确认|澄清)|Original user prompt:|pet_[a-f0-9]{24,}/i;
const secretText = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{60,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const personalEmail = /[A-Z0-9._%+-]+@(?:gmail|outlook|hotmail|icloud|qq|163|126)\.[A-Z]{2,}/i;
const textSuffix = /\.(?:json|md|txt|ya?ml|m?js)$/i;
const publicRoles = new Set([
  "codex-pet-v2", "pet-manifest", "shell-theme", "package-readme",
  "attribution-notice", "license-notice", "shell-skin", "shell-skin-character",
  "shell-skin-atmosphere", "dsh-pet-retina-adaptive", "dsh-pet-manifest",
  "dsh-pet-native-sequence", "upstream-license-yunyuesama", "upstream-license-scope-yunyuesama",
]);

export function auditPublicText(name, data) {
  if (privatePath.test(name)) throw new Error(`working record in payload: ${name}`);
  const bytes = Buffer.from(data);
  const values = [bytes.toString("utf8"), bytes.toString("utf16le")];
  for (const value of values) {
    if (privateText.test(value)) throw new Error(`private content in payload: ${name}`);
    if (secretText.test(value)) throw new Error(`credential pattern in payload: ${name}`);
    if (personalEmail.test(value)) throw new Error(`personal contact in payload: ${name}`);
  }
}

export function auditCompanionPayload(bytes) {
  inspectZipContainer(bytes, DEFAULT_MAX_BUNDLE_BYTES);
  const entries = unzipSync(new Uint8Array(bytes));
  validateCompanionEntries(entries);
  const definition = JSON.parse(new TextDecoder().decode(entries["definition/being-definition.json"]));
  const allowed = new Set(["companion.json", "definition/being-definition.json"]);
  for (const resource of definition.resources) {
    if (!publicRoles.has(resource.role)) throw new Error("unreviewed role in bundled companion");
    allowed.add(`definition/${resource.path}`);
  }
  for (const [name, data] of Object.entries(entries)) {
    if (!allowed.has(name)) throw new Error(`undeclared file in bundled companion: ${name}`);
    if (privatePath.test(name)) throw new Error(`working record in bundled companion: ${name}`);
    if (textSuffix.test(name)) auditPublicText(name, data);
  }
  return Object.keys(entries).sort();
}
