import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLocalcacheSeedExtractScript,
  createThemeCssWarmupPhp,
} from "../../src/runtime/bootstrap.js";

describe("buildLocalcacheSeedExtractScript", () => {
  it("extracts into the runtime localcache via ZipArchive", () => {
    const script = buildLocalcacheSeedExtractScript(
      "/tmp/moodle/moodle-localcache-seed.zip",
      "",
    );
    assert.ok(script.includes("new ZipArchive()"));
    assert.ok(script.includes("'/persist/moodledata/localcache'"));
    assert.ok(script.includes("'/tmp/moodle/moodle-localcache-seed.zip'"));
    assert.ok(script.includes("json_encode($result"));
  });

  it("keeps the CSS rewrite inert on root deploys (empty prefix)", () => {
    const script = buildLocalcacheSeedExtractScript("/tmp/seed.zip", "");
    assert.ok(script.includes("$prefix = '';"));
    assert.ok(script.includes("if ($prefix !== '')"));
  });

  it("rewrites theme image/font URLs with the deploy base path", () => {
    const script = buildLocalcacheSeedExtractScript(
      "/tmp/seed.zip",
      "/moodle-playground",
    );
    assert.ok(script.includes("$prefix = '/moodle-playground';"));
    assert.ok(script.includes("'/theme/image.php/'"));
    assert.ok(script.includes("'/theme/font.php/'"));
    // Only candidate sheets are touched.
    assert.ok(script.includes("/theme/*/*/css/*.css"));
  });
});

describe("createThemeCssWarmupPhp", () => {
  it("builds the candidate sheet via theme_build_css_for_themes", () => {
    const script = createThemeCssWarmupPhp();
    assert.ok(script.includes("theme_build_css_for_themes([$theme]"));
    // The sheet styles.php actually serves: css/ subdir + _<subrev> suffix,
    // resolved through core's own helper rather than a hand-rolled path.
    assert.ok(script.includes("theme_get_css_filename("));
    assert.ok(script.includes("theme_get_sub_revision_for_theme("));
  });

  it("no longer hand-writes the broken candidate path", () => {
    const script = createThemeCssWarmupPhp();
    // The old implementation wrote localcache/theme/<rev>/<name>/all.css
    // (missing the css/ subdir and the _<subrev> suffix), which styles.php
    // never found — the first page view recompiled the SCSS again.
    assert.ok(!script.includes('make_localcache_directory("theme/'));
    assert.ok(!script.includes("$candidatedir/$type.css"));
  });
});
