// version-sync.test.mjs — assert package.json's version is valid SemVer and documented in
// CHANGELOG.md. Scaffolded by repo-bootstrap (Portka standard); run with `node --test` (or vitest).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;

test("version is valid SemVer", () => {
  assert.match(version, /^\d+\.\d+\.\d+([-+][0-9A-Za-z.]+)?$/);
});

test("CHANGELOG.md has a release section for the current version", () => {
  const log = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  // Anchor to a Keep-a-Changelog heading (## [x.y.z]), not a bare substring: a loose match also
  // passed on a URL, a prose mention, or an unrelated version. Brackets optional; dots escaped.
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(String.raw`^##\s+\[?${esc}\]?(\s|$)`, "m");
  assert.ok(heading.test(log), `CHANGELOG.md has no "## [${version}]" release section`);
});
