import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { createUstarTar } from "../../scripts/lib/tar-ustar.mjs";
import {
  bootstrapMoodle,
  startArchiveResolution,
} from "../../src/runtime/bootstrap.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const json = (value) => JSON.stringify(value);

const CACHE_LINE =
  "debugging('Invalid cache store in config. Missing name or plugin.', DEBUG_DEVELOPER);";
const NAV_REDIRECT = `if ($hassiteconfig && moodle_needs_upgrading()) {
    redirect(new moodle_url('/admin/index.php'));
}`;
const ADMIN_CACHE_REDIRECT = `if (!$cache) {
    redirect(new moodle_url('/admin/index.php', array('cache' => 1)));
}`;
const SODIUM = '<PHP_EXTENSION name="sodium" level="required"/>';

// Core files patchRuntimePhpSources reads; some carry upstream snippets so
// the patches have something to rewrite.
function coreFiles(prefix) {
  return {
    [`${prefix}cache/classes/config.php`]: `<?php ${CACHE_LINE}`,
    [`${prefix}cache/classes/administration_helper.php`]: "<?php",
    [`${prefix}lib/classes/update/code_manager.php`]: "<?php",
    [`${prefix}lib/classes/plugin_manager.php`]: "<?php",
    [`${prefix}lib/classes/component.php`]: "<?php",
    [`${prefix}lib/adminlib.php`]: "<?php",
    [`${prefix}admin/environment.xml`]: SODIUM,
    [`${prefix}admin/search.php`]: `<?php ${NAV_REDIRECT}`,
    [`${prefix}admin/index.php`]: `<?php ${ADMIN_CACHE_REDIRECT}`,
    [`${prefix}my/index.php`]: "<?php",
    [`${prefix}my/courses.php`]: "<?php",
    ".playground/core_component.php": "<?php $cache = [];",
  };
}

function makeArchive({ prefix = "", snapshot, fileCount } = {}) {
  const files = coreFiles(prefix);
  const entries = Object.entries(files).map(([name, data]) => ({
    name,
    data: enc(data),
  }));
  return {
    manifest: {
      release: "5.0.1 (Build: 1)",
      generatedAt: "2026-01-01T00:00:00Z",
      bundle: {
        codec: "gzip",
        sha256: "abc",
        fileCount: fileCount ?? entries.length,
      },
      ...(snapshot ? { snapshot } : {}),
    },
    bytes: gzipSync(createUstarTar(entries)),
  };
}

// In-memory PHP runtime: a flat file map plus scripted run()/request().
function makePhp({ run = {}, request = {}, files = {} } = {}) {
  const fs = new Map(Object.entries(files).map(([k, v]) => [k, enc(v)]));
  const dirs = new Set(["/"]);
  const runs = [];
  const requests = [];
  const write = (path, data) =>
    fs.set(path, typeof data === "string" ? enc(data) : new Uint8Array(data));
  const read = (path) => {
    if (!fs.has(path)) throw new Error(`ENOENT ${path}`);
    return fs.get(path);
  };
  const runHandlers = {
    "SELECT value FROM mdl_config WHERE name = 'playground_blueprint_checkpoint'":
      () => "null",
    "'playground_blueprint_checkpoint', :value": () => "checkpoint-saved",
    "moodle-localcache-seed.zip": () =>
      `notice\n${json({ ok: true, entries: 3, rewritten: 1 })}`,
    "set_config('lang'": () =>
      json({ ok: true, lang: "es", action: "applied", previous: "en" }),
    lang_installer: () => json({ ok: true, lang: "en", action: "skipped" }),
    dbFileExists: () => json({ dbFileExists: true }),
    "@unlink": () => "",
    ...run,
  };
  const requestHandlers = {
    "/__install_check.php": () => json({ installed: false }),
    "/__install_database.php": (url) =>
      `stage:${url.searchParams.get("stage")}:ok`,
    "/__pdo_probe.php": () => json({ ok: true, dsn: "sqlite:x" }),
    "/__config_normalizer.php": () => json({ ok: true, set: { a: 1 } }),
    "/__theme_css_warmup.php": () => json({ ok: true, size: 10, rev: 7 }),
    "/__playground_autologin.php": () => json({ ok: true }),
    ...request,
  };
  const php = {
    runs,
    requests,
    fs,
    async analyzePath(path) {
      if (dirs.has(path)) return { exists: true, object: { isFolder: true } };
      if (fs.has(path))
        return { exists: true, object: { isFolder: false, mode: 33188 } };
      return { exists: false };
    },
    async mkdir(path) {
      dirs.add(path);
    },
    async readFile(path) {
      return read(path);
    },
    async writeFile(path, data) {
      write(path, data);
    },
    async run(code) {
      runs.push(code);
      const key = Object.keys(runHandlers).find((k) => code.includes(k));
      if (!key) throw new Error(`Unexpected script: ${code.slice(0, 80)}`);
      return { text: runHandlers[key](code) };
    },
    async request(req) {
      const url = new URL(req.url);
      requests.push(url.pathname + url.search);
      const handler = requestHandlers[url.pathname];
      if (!handler) return new Response("missing", { status: 404 });
      const out = handler(url);
      return out instanceof Response ? out : new Response(out);
    },
    _php: {
      async readFileAsText(path) {
        return fs.has(path) ? dec(fs.get(path)) : "";
      },
      // Sync: the tar extractor does not await; the ini helper does.
      writeFile(path, data) {
        write(path, data);
      },
      mkdirTree(path) {
        dirs.add(path);
      },
    },
  };
  return php;
}

const CONFIG = {
  bundleVersion: "b1",
  siteTitle: "Playground",
  admin: { username: "admin", password: "pw", email: "a@example.test" },
  runtimes: [{ id: "php83-moodle50", default: true }],
};

function boot(php, overrides = {}) {
  const log = [];
  const promise = bootstrapMoodle({
    config: CONFIG,
    blueprint: undefined,
    php,
    publish: (msg) => log.push(msg),
    runtimeId: "php83-moodle50",
    scopeId: "s-1",
    appBaseUrl: "https://example.test/sub/",
    moodleBranch: "MOODLE_500_STABLE",
    archivePromise: Promise.resolve(makeArchive()),
    ...overrides,
  });
  return promise.then((result) => ({ result, log }));
}

const INSTALL_STATE =
  "/persist/config/moodle-playground-install-s_1-php83_moodle50.json";
const has = (log, re) => log.some((line) => re.test(line));

describe("bootstrapMoodle", () => {
  it("installs a fresh site through the CLI stages, patches core and auto-logs in", async () => {
    const php = makePhp();
    const { result, log } = await boot(php);

    // Every install stage ran in order before the marker was written.
    assert.deepEqual(
      php.requests.filter((r) => r.startsWith("/__install_database")),
      ["core", "plugins", "finalize", "themes"].map(
        (s) => `/__install_database.php?stage=${s}`,
      ),
    );
    const state = JSON.parse(dec(php.fs.get(INSTALL_STATE)));
    assert.equal(state.installed, true);
    assert.equal(state.source, "cli");
    assert.equal(state.dbName, "moodle_s_1_php83_moodle50");
    assert.equal(state.release, "5.0.1 (Build: 1)");

    // Runtime config and helper scripts are in place with the real wwwroot.
    const config = dec(php.fs.get("/www/moodle/config.php"));
    assert.match(config, /https:\/\/example\.test\/sub/);
    assert.match(config, /moodle_s_1_php83_moodle50\.sq3\.php/);
    for (const script of [
      "__autoload_check.php",
      "__install_check.php",
      "__install_database.php",
      "__pdo_probe.php",
      "__config_normalizer.php",
      "__theme_css_warmup.php",
    ]) {
      assert.ok(php.fs.has(`/www/moodle/${script}`), script);
    }
    assert.match(
      dec(php.fs.get("/www/moodle/__install_database.php")),
      /"adminuser":"admin"/,
    );

    // Core patches applied; untouched files stay byte-identical.
    assert.match(
      dec(php.fs.get("/www/moodle/cache/classes/config.php")),
      /if \(!\(defined\('CACHE_DISABLE_ALL'\)/,
    );
    assert.match(
      dec(php.fs.get("/www/moodle/admin/environment.xml")),
      /level="optional"/,
    );
    assert.match(
      dec(php.fs.get("/www/moodle/admin/search.php")),
      /PLAYGROUND_SKIP_NAV_UPGRADE_REDIRECTS/,
    );
    assert.match(dec(php.fs.get("/www/moodle/admin/index.php")), /'pgmm'/);
    assert.equal(dec(php.fs.get("/www/moodle/my/index.php")), "<?php");

    assert.ok(has(log, /Post-install DB verify/));
    assert.ok(has(log, /Seeded missing config defaults: a/));
    assert.ok(has(log, /Theme CSS compiled and cached \(10 bytes, rev 7\)/));
    assert.ok(has(log, /Auto-login session created/));
    assert.ok(php.runs.some((c) => c.includes("@unlink")));
    assert.equal(result.readyPath, "/my/");
    assert.equal(result.manifestState.runtimeId, "php83-moodle50");
    assert.equal(typeof result.timings.prepareMs, "number");
  });

  it("fails without writing the install marker when a CLI stage is incomplete", async () => {
    const php = makePhp({
      request: {
        "/__install_database.php": (url) =>
          url.searchParams.get("stage") === "plugins"
            ? "Fatal error: boom"
            : `stage:${url.searchParams.get("stage")}:ok`,
      },
    });
    await assert.rejects(
      boot(php),
      /incomplete stages: plugins; Fatal error: boom/,
    );
    assert.equal(php.fs.has(INSTALL_STATE), false);
  });

  it("reports the HTTP failure of a runtime script with its FS state", async () => {
    const php = makePhp({
      request: {
        "/__config_normalizer.php": () => new Response("oops", { status: 500 }),
      },
    });
    await assert.rejects(
      boot(php),
      /__config_normalizer\.php: HTTP 500: oops[\s\S]*existed before request: true mode=33188/,
    );
  });

  it("rejects a core bundle whose file count does not match the manifest", async () => {
    const php = makePhp();
    await assert.rejects(
      boot(php, {
        archivePromise: Promise.resolve(makeArchive({ fileCount: 999 })),
      }),
      /file-count parity mismatch: extracted 12, manifest 999/,
    );
  });

  it("loads the install snapshot and localcache seed, then runs the blueprint", async () => {
    const snapshotBytes = new Uint8Array(200).fill(7);
    const restore = mockFetch({
      "https://cdn.test/install.sq3": snapshotBytes,
      "https://cdn.test/localcache.zip": new Uint8Array([1, 2, 3]),
    });
    try {
      const php = makePhp({
        request: {
          "/__theme_css_warmup.php": () => {
            throw new Error("warmup must be skipped");
          },
        },
      });
      php.flushPersistence = async () => ({
        ok: true,
        hydratedBytes: 5,
        flushedOps: 2,
      });
      const { result, log } = await boot(php, {
        debug: "true",
        archivePromise: Promise.resolve(
          makeArchive({
            snapshot: {
              url: "https://cdn.test/install.sq3",
              requirejs: true,
              localcache: { url: "https://cdn.test/localcache.zip" },
            },
          }),
        ),
        blueprint: {
          siteOptions: { locale: "es", timezone: "Europe/Madrid" },
          runtime: { debug: 15 },
          phpConstants: { MY_FLAG: true },
          steps: [{ step: "setLandingPage", path: "/course/view.php?id=2" }],
        },
      });
      const db = "/persist/moodledata/moodle_s_1_php83_moodle50.sq3.php";
      assert.deepEqual(php.fs.get(db), snapshotBytes);
      assert.equal(
        JSON.parse(dec(php.fs.get(INSTALL_STATE))).source,
        "snapshot",
      );
      assert.ok(has(log, /Localcache seed applied \(3 entries, 1 stylesheet/));
      assert.ok(has(log, /skipping SCSS warmup/));
      assert.ok(has(log, /Configured site language 'es' \(was 'en'\)/));
      assert.ok(
        has(log, /PDO SQLite probe connected successfully with sqlite:x/),
      );
      assert.ok(has(log, /\[runtime-selection\]\[bootstrap:resolved\]/));
      // debug=true overrides the blueprint and enables display_errors.
      const ini = dec(php.fs.get("/internal/shared/php.ini"));
      assert.match(ini, /display_errors\s*=\s*"?1/);
      assert.match(ini, /date\.timezone\s*=\s*"?Europe\/Madrid/);
      assert.match(dec(php.fs.get("/www/moodle/config.php")), /MY_FLAG/);
      assert.equal(result.readyPath, "/course/view.php?id=2");
      assert.ok(has(log, /Blueprint persistence flush: \d+ms, 5 bytes, 2 ops/));
    } finally {
      restore();
    }
  });

  it("re-applies the seed on a journaled snapshot reload and skips install checks", async () => {
    const archive = makeArchive({
      snapshot: { localcache: { fileName: "seed.zip" } },
    });
    const php = makePhp({
      files: {
        [INSTALL_STATE]: json({
          runtimeId: "php83-moodle50",
          bundleVersion: "b1",
          release: archive.manifest.release,
          sha256: "abc",
          dbName: "moodle_s_1_php83_moodle50",
          installed: true,
          source: "snapshot",
        }),
      },
      run: {
        lang_installer: () =>
          json({ ok: true, lang: "es", action: "already-installed" }),
      },
    });
    const restore = mockFetch({
      "https://example.test/sub/assets/moodle/MOODLE_500_STABLE/snapshot/seed.zip":
        new Uint8Array([9]),
    });
    try {
      const { log } = await boot(php, {
        archivePromise: Promise.resolve(archive),
      });
      assert.ok(has(log, /Using persisted install marker/));
      assert.ok(has(log, /already installed, skipping CLI provisioning/));
      assert.ok(has(log, /Localcache seed applied/));
      assert.ok(has(log, /'es' already present/));
      assert.equal(
        php.requests.some((r) => r.startsWith("/__install")),
        false,
      );
    } finally {
      restore();
    }
  });

  it("adopts an installed database found by the provisioning check", async () => {
    const php = makePhp({
      files: { [INSTALL_STATE]: json({ installed: true, release: "old" }) },
      request: {
        "/__install_check.php": () => `warn\n${json({ installed: true })}`,
        "/__config_normalizer.php": () => json({ ok: true, set: {} }),
        "/__theme_css_warmup.php": () =>
          json({ ok: false, error: { message: "scss" } }),
        "/__playground_autologin.php": () =>
          new Response("nope", { status: 500 }),
      },
      run: {
        lang_installer: () =>
          json({ ok: false, lang: "fr", action: "error", error: "net" }),
      },
    });
    const { result, log } = await boot(php, { debug: "0", profile: "pdo" });
    assert.ok(has(log, /detected from the config table\./));
    assert.equal(
      JSON.parse(dec(php.fs.get(INSTALL_STATE))).release,
      "5.0.1 (Build: 1)",
    );
    assert.ok(has(log, /Persisted config defaults already present/));
    assert.ok(has(log, /Theme CSS warmup failed: scss/));
    assert.ok(has(log, /'fr' could not be installed \(net\)/));
    assert.equal(result.readyPath, "/login/index.php");
  });

  it("keeps booting when diagnostics and optional steps fail", async () => {
    const php = makePhp({
      request: {
        "/__install_check.php": () => "not json",
        "/__pdo_probe.php": () =>
          json({ ok: false, error: { message: "no driver" } }),
        "/__config_normalizer.php": () =>
          json({ ok: false, error: { message: "bad cfg" } }),
        "/__theme_css_warmup.php": () => {
          throw new Error("wasm oom");
        },
        "/__playground_autologin.php": () => {
          throw new Error("down");
        },
      },
      run: {
        dbFileExists: () => {
          throw new Error("verify crashed");
        },
        "set_config('lang'": () => {
          throw new Error("lang crashed");
        },
        lang_installer: () => {
          throw new Error("pack crashed");
        },
        "@unlink": () => {
          throw new Error("ignored");
        },
      },
    });
    const { result, log } = await boot(php, {
      profile: "runtime",
      blueprint: { siteOptions: { locale: "de" } },
    });
    assert.ok(
      has(
        log,
        /Provisioning check failed \(Provisioning check returned non-JSON/,
      ),
    );
    assert.ok(has(log, /PDO SQLite probe failed: no driver/));
    assert.ok(has(log, /Post-install DB verify failed: verify crashed/));
    assert.ok(has(log, /Config default normalization failed: bad cfg/));
    assert.ok(has(log, /Theme CSS warmup crashed \(wasm oom\)/));
    assert.ok(has(log, /Site language configuration failed \(lang crashed\)/));
    assert.ok(has(log, /Language auto-install crashed \(pack crashed\)/));
    assert.ok(has(log, /Auto-login failed: down/));
    assert.equal(result.readyPath, "/login/index.php");
  });

  it("logs the provisioning check error payload and a failed blueprint step", async () => {
    const php = makePhp({
      request: {
        "/__install_check.php": () =>
          json({ error: { type: "dml", message: "locked" } }),
      },
      run: {
        lang_installer: () =>
          json({ ok: true, lang: "pt", action: "installed" }),
      },
    });
    const { log } = await boot(php, {
      debug: "minimal",
      blueprint: { steps: [{ step: "setLandingPage" }] },
    });
    assert.ok(has(log, /Provisioning check failed: dml: locked/));
    assert.ok(
      has(
        log,
        /Blueprint failed at step 1:setLandingPage: setLandingPage: 'path' is required/,
      ),
    );
    assert.ok(has(log, /Installed site language pack 'pt'/));
  });

  it("serves 5.1+ helper scripts from the public/ web root", async () => {
    const php = makePhp();
    await boot(php, {
      runtimeId: "php83-moodle51",
      moodleBranch: "MOODLE_501_STABLE",
      archivePromise: Promise.resolve(makeArchive({ prefix: "public/" })),
    });
    assert.ok(php.fs.has("/www/moodle/public/__install_database.php"));
    assert.ok(php.fs.has("/www/moodle/config.php"));
    assert.match(
      dec(php.fs.get("/www/moodle/public/admin/environment.xml")),
      /level="optional"/,
    );
  });

  it("falls back to the CLI install when the snapshot is too small", async () => {
    const restore = mockFetch({
      "https://cdn.test/tiny.sq3": new Uint8Array(4),
    });
    try {
      const php = makePhp();
      const { log } = await boot(php, {
        archivePromise: Promise.resolve(
          makeArchive({ snapshot: { url: "https://cdn.test/tiny.sq3" } }),
        ),
      });
      assert.ok(has(log, /Snapshot too small, falling back to full install/));
      assert.equal(JSON.parse(dec(php.fs.get(INSTALL_STATE))).source, "cli");
    } finally {
      restore();
    }
  });

  it("compiles theme CSS after a snapshot boot without a localcache seed", async () => {
    const restore = mockFetch({
      "https://cdn.test/install.sq3": new Uint8Array(200),
    });
    try {
      const php = makePhp();
      const { log } = await boot(php, {
        archivePromise: Promise.resolve(
          makeArchive({ snapshot: { url: "https://cdn.test/install.sq3" } }),
        ),
      });
      assert.ok(has(log, /Install snapshot loaded/));
      assert.equal(has(log, /Localcache seed/), false);
      assert.ok(has(log, /Theme CSS compiled and cached/));
    } finally {
      restore();
    }
  });

  for (const [name, seedRun, url, expected] of [
    [
      "a failed seed download",
      undefined,
      "https://cdn.test/gone.zip",
      /Unable to download asset: 404/,
    ],
    [
      "non-JSON extractor output",
      () => "garbage",
      "https://cdn.test/seed.zip",
      /non-JSON output: garbage/,
    ],
    [
      "an extractor error",
      () => json({ ok: false, error: { message: "zip" } }),
      "https://cdn.test/seed.zip",
      /Localcache seed extraction failed: zip/,
    ],
  ]) {
    it(`fails loud on ${name} for an advertised seed`, async () => {
      const restore = mockFetch({
        "https://cdn.test/install.sq3": new Uint8Array(200),
        "https://cdn.test/seed.zip": new Uint8Array([1]),
      });
      try {
        const php = makePhp(
          seedRun ? { run: { "moodle-localcache-seed.zip": seedRun } } : {},
        );
        await assert.rejects(
          boot(php, {
            archivePromise: Promise.resolve(
              makeArchive({
                snapshot: {
                  url: "https://cdn.test/install.sq3",
                  localcache: { url },
                },
              }),
            ),
          }),
          expected,
        );
      } finally {
        restore();
      }
    });
  }

  for (const [stored, expected] of [
    ["null", /Legacy persisted instance has no blueprint checkpoint/],
    [
      json({ version: 1, fingerprint: "old", completed: [] }),
      /The blueprint changed since this instance was provisioned/,
    ],
  ]) {
    it(`warns about ${expected.source.slice(4, 30)} on reload`, async () => {
      const php = makePhp({
        request: {
          "/__install_check.php": () => json({ installed: true }),
        },
        run: {
          "SELECT value FROM mdl_config WHERE name = 'playground_blueprint_checkpoint'":
            () => stored,
        },
      });
      const { log } = await boot(php, {
        blueprint: { steps: [{ step: "setLandingPage", path: "/x" }] },
      });
      assert.ok(has(log, expected));
    });
  }

  it("rejects a config without any runtime", async () => {
    await assert.rejects(
      boot(makePhp(), { config: { runtimes: [] } }),
      /Unable to resolve a runtime configuration/,
    );
  });

  for (const [debug, expected] of [
    ["off", /display_errors/],
    ["normal", null],
    ["42", null],
    ["nonsense", null],
  ]) {
    it(`normalizes the debug override ${debug}`, async () => {
      const php = makePhp();
      await boot(php, { debug });
      const ini = php.fs.get("/internal/shared/php.ini");
      if (debug === "off") {
        assert.equal(ini, undefined);
      } else if (debug === "nonsense") {
        assert.equal(ini, undefined);
      } else {
        assert.match(dec(ini), expected ?? /display_errors\s*=\s*"?1/);
      }
    });
  }
});

function mockFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = routes[String(url)];
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body);
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe("startArchiveResolution", () => {
  let restore;
  beforeEach(() => {
    globalThis.self = { location: { href: "https://example.test/" } };
    globalThis.caches = {
      open: async () => ({
        match: async () => undefined,
        put: async () => {},
        delete: async () => true,
      }),
    };
  });
  afterEach(() => {
    restore?.();
    delete globalThis.caches;
    delete globalThis.self;
  });

  it("maps manifest and download progress onto the boot progress bar", async () => {
    const bundle = new Uint8Array(64).fill(1);
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.endsWith("MOODLE_500_STABLE.json")) {
        if (init?.method === "HEAD") return new Response(null);
        return new Response(
          json({
            release: "5.0",
            bundle: { path: "core.tar.zst", sha256, size: bundle.length },
          }),
        );
      }
      if (href.endsWith("core.tar.zst")) return new Response(bundle);
      return new Response("missing", { status: 404 });
    };
    restore = () => {
      globalThis.fetch = original;
    };
    const events = [];
    const archive = await startArchiveResolution({
      moodleBranch: "MOODLE_500_STABLE",
      appBaseUrl: "https://example.test/",
      publish: (msg, progress) => events.push([msg, progress]),
    });
    assert.deepEqual(archive.bytes, bundle);
    assert.equal(archive.manifest.release, "5.0");
    assert.equal(events[0][1], 0.16);
    assert.match(events[0][0], /MOODLE_500_STABLE\.json/);
    const last = events.at(-1);
    assert.match(last[0], /Downloading Moodle bundle \(100%/);
    assert.ok(last[1] > 0.5 && last[1] <= 0.56);
  });
});
