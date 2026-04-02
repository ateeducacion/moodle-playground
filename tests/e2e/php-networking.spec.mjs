import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  captureDiagnostics,
  createDiagnosticsCollector,
  findMoodleFrame,
  waitForPlaygroundReady,
  waitForRuntimeFrameReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: 180_000 });
test.use({ ignoreHTTPSErrors: true });

let localHttpsServer;
let localHttpsBaseUrl;
let localHttpsTmpDir;
let localCorsProxyServer;
let localAddonProxyBaseUrl;
let localCorsProxyBaseUrl;
let localCorsProxyHits = [];
const EXELEARNING_RELEASES_FEED_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>eXeLearning Releases</title>
  <entry>
    <title>v4.0.0-beta3</title>
  </entry>
</feed>`;
const EXELEARNING_RELEASE_ZIP_FIXTURE = Buffer.from([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
]);
const EXELEARNING_RELEASES_ATOM_URL =
  "https://github.com/exelearning/exelearning/releases.atom";
const EXELEARNING_RELEASE_VERSION = "4.0.0-beta3";
const EXELEARNING_RELEASE_ASSET_URL = `https://github.com/exelearning/exelearning/releases/download/v${EXELEARNING_RELEASE_VERSION}/exelearning-static-v${EXELEARNING_RELEASE_VERSION}.zip`;

test.beforeAll(async () => {
  localHttpsTmpDir = await mkdtemp(join(tmpdir(), "moodle-playground-https-"));
  const keyPath = join(localHttpsTmpDir, "localhost.key");
  const certPath = join(localHttpsTmpDir, "localhost.crt");

  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);

  const [key, cert] = await Promise.all([
    readFile(keyPath, "utf8"),
    readFile(certPath, "utf8"),
  ]);

  localHttpsServer = https.createServer({ key, cert }, (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.pathname === "/plain") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("local-https-ok");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  await new Promise((resolve) => {
    localHttpsServer.listen(0, "127.0.0.1", resolve);
  });
  const address = localHttpsServer.address();
  localHttpsBaseUrl = `https://localhost:${address.port}`;

  localCorsProxyServer = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "X-Playground-Cors-Proxy");
    res.setHeader("X-Playground-Cors-Proxy", "true");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const target = url.searchParams.get("url");
    localCorsProxyHits.push({
      method: req.method,
      target,
      repo: url.searchParams.get("repo"),
      atom: url.searchParams.get("atom"),
    });

    if (
      url.searchParams.get("repo") === "exelearning/exelearning" &&
      url.searchParams.get("atom") === "releases"
    ) {
      res.writeHead(200, {
        "Content-Type": "application/atom+xml; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(EXELEARNING_RELEASES_FEED_FIXTURE);
      return;
    }

    if (target === "https://remote-server.example/plain") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("proxy-fallback-ok");
      return;
    }

    if (target === EXELEARNING_RELEASES_ATOM_URL) {
      res.writeHead(200, {
        "Content-Type": "application/atom+xml; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(EXELEARNING_RELEASES_FEED_FIXTURE);
      return;
    }

    if (target === EXELEARNING_RELEASE_ASSET_URL) {
      const range = req.headers.range || "";
      const wantsPrefix = /bytes=0-3/u.test(range);
      const body = wantsPrefix
        ? EXELEARNING_RELEASE_ZIP_FIXTURE.subarray(0, 4)
        : EXELEARNING_RELEASE_ZIP_FIXTURE;
      res.writeHead(wantsPrefix ? 206 : 200, {
        "Content-Type": "application/zip",
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
        "Content-Length": String(body.length),
        ...(wantsPrefix
          ? {
              "Content-Range": `bytes 0-3/${EXELEARNING_RELEASE_ZIP_FIXTURE.length}`,
            }
          : {}),
      });
      res.end(body);
      return;
    }

    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`unexpected target: ${target}`);
  });

  await new Promise((resolve) => {
    localCorsProxyServer.listen(0, "127.0.0.1", resolve);
  });
  const proxyAddress = localCorsProxyServer.address();
  localAddonProxyBaseUrl = `http://127.0.0.1:${proxyAddress.port}/`;
  localCorsProxyBaseUrl = `http://127.0.0.1:${proxyAddress.port}/?url=`;
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => {
    if (!localHttpsServer) {
      resolve();
      return;
    }
    localHttpsServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  await new Promise((resolve, reject) => {
    if (!localCorsProxyServer) {
      resolve();
      return;
    }
    localCorsProxyServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  if (localHttpsTmpDir) {
    await rm(localHttpsTmpDir, { recursive: true, force: true });
  }
});

function buildBlueprintParam(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function buildNetworkingBlueprint(siteName, files) {
  return buildBlueprintParam({
    landingPage: "/my/",
    steps: [
      {
        step: "installMoodle",
        options: {
          adminUser: "admin",
          adminPass: "password",
          adminEmail: "admin@example.com",
          siteName,
        },
      },
      { step: "login", username: "admin" },
      ...[
        {
          path: "/www/moodle/playground-ready.php",
          literal:
            "<?php require(__DIR__ . '/config.php'); header('Content-Type: application/json'); echo json_encode(['ready' => true, 'moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND], JSON_PRETTY_PRINT);",
        },
        ...files,
      ].map(({ path, literal }) => ({
        step: "writeFile",
        path,
        data: { literal },
      })),
    ],
  });
}

async function fetchPhpJson(page, path) {
  const fetchText = async (target, scriptPath) =>
    await target.evaluate(async (resolvedPath) => {
      const response = await fetch(resolvedPath, { cache: "no-store" });
      return await response.text();
    }, scriptPath);

  try {
    return JSON.parse(await fetchText(page, path));
  } catch (error) {
    const moodleFrame = findMoodleFrame(page);
    if (!moodleFrame) {
      throw error;
    }

    return JSON.parse(await fetchText(moodleFrame, path));
  }
}

test.beforeEach(() => {
  localCorsProxyHits = [];
});

test("PHP direct HTTPS to a self-signed local server still fails before proxy fallback", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName === "firefox");
  const diagnostics = createDiagnosticsCollector(page);
  const bp = buildNetworkingBlueprint("PHP Local HTTPS Test", [
    {
      path: "/www/moodle/playground-net-local-https.php",
      literal: `<?php require(__DIR__ . '/config.php'); $url = '${localHttpsBaseUrl}/plain'; $body = @file_get_contents($url); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 10]); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_body' => is_string($body) ? $body : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_body' => is_string($curlbody) ? $curlbody : null], JSON_PRETTY_PRINT);`,
    },
  ]);

  try {
    await page.goto(`/?blueprint=${bp}`);
    await waitForPlaygroundReady(page);

    const result = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-local-https.php",
    );

    expect(result.moodle_playground).toBe(true);
    expect(result.url).toBe(`${localHttpsBaseUrl}/plain`);
    expect(result.fgc_ok).toBe(false);
    expect(result.fgc_error).toMatch(/Failed to open stream: operation failed/);
    expect(result.fgc_body).toBeNull();
    expect(result.curl_errno).toBe(35);
    expect(result.curl_error).toMatch(/SSL_ERROR_SYSCALL|UnknownCa|ASN1/i);
    expect(result.curl_http_code).toBe(0);
    expect(result.curl_body).toBeNull();
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("PHP can fetch GitHub releases atom feed through the same-origin playground proxy", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName === "firefox");
  const diagnostics = createDiagnosticsCollector(page);
  const bp = buildNetworkingBlueprint("PHP Networking Test", [
    {
      path: "/www/moodle/playground-net-github.php",
      literal:
        "<?php require(__DIR__ . '/config.php'); $base = defined('MOODLE_PLAYGROUND_PROXY_URL') && MOODLE_PLAYGROUND_PROXY_URL !== '' ? MOODLE_PLAYGROUND_PROXY_URL : rtrim($CFG->wwwroot, '/') . '/__playground_proxy__'; $url = $base . '?repo=exelearning%2Fexelearning&atom=releases'; $body = @file_get_contents($url); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 10]); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_body_prefix' => is_string($body) ? substr($body, 0, 200) : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_body_prefix' => is_string($curlbody) ? substr($curlbody, 0, 200) : null], JSON_PRETTY_PRINT);",
    },
  ]);

  try {
    await page.goto(
      `/?blueprint=${bp}&addonProxyUrl=${encodeURIComponent(localAddonProxyBaseUrl)}`,
    );
    await waitForPlaygroundReady(page);

    const result = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-github.php",
    );

    expect(result.moodle_playground).toBe(true);
    expect(result.url).toContain(
      "/__playground_proxy__?repo=exelearning%2Fexelearning&atom=releases",
    );
    expect(result.fgc_ok).toBe(true);
    expect(result.fgc_body_prefix).toMatch(/<feed|<\?xml/i);
    expect(result.curl_errno).toBe(0);
    expect(result.curl_http_code).toBe(200);
    expect(result.curl_body_prefix).toMatch(/<feed|<\?xml/i);
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("PHP HTTP requests fall back to the configured phpCorsProxyUrl", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName === "firefox");
  const diagnostics = createDiagnosticsCollector(page);

  const bp = buildNetworkingBlueprint("PHP Networking Proxy Fallback Test", [
    {
      path: "/www/moodle/playground-net-fallback.php",
      literal:
        "<?php require(__DIR__ . '/config.php'); $url = 'http://remote-server.example/plain'; $body = @file_get_contents($url); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 10]); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_body' => is_string($body) ? $body : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_body' => is_string($curlbody) ? $curlbody : null], JSON_PRETTY_PRINT);",
    },
  ]);

  try {
    await page.goto(
      `/?blueprint=${bp}&phpCorsProxyUrl=${encodeURIComponent(localCorsProxyBaseUrl)}`,
    );
    await waitForPlaygroundReady(page);

    const result = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-fallback.php",
    );

    expect(result.moodle_playground).toBe(true);
    expect(result.url).toBe("http://remote-server.example/plain");
    expect(result.fgc_ok).toBe(true);
    expect(result.fgc_body).toBe("proxy-fallback-ok");
    expect(result.curl_errno).toBe(0);
    expect(result.curl_http_code).toBe(200);
    expect(result.curl_body).toBe("proxy-fallback-ok");
    expect(
      localCorsProxyHits
        .filter(
          ({ target }) => target === "https://remote-server.example/plain",
        )
        .map(({ method, target }) => ({ method, target })),
    ).toEqual([
      { method: "GET", target: "https://remote-server.example/plain" },
      { method: "GET", target: "https://remote-server.example/plain" },
    ]);
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("PHP direct HTTPS works for a CORS-open external URL", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName === "firefox");
  const diagnostics = createDiagnosticsCollector(page);
  const bp = buildNetworkingBlueprint("PHP Networking Direct Test", [
    {
      path: "/www/moodle/playground-net-external-https.php",
      literal:
        "<?php require(__DIR__ . '/config.php'); $url = 'https://raw.githubusercontent.com/WordPress/wordpress-playground/5e5ba3e0f5b984ceadd5cbe6e661828c14621d25/README.md'; $body = @file_get_contents($url); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 10]); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_body_prefix' => is_string($body) ? substr($body, 0, 200) : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_body_prefix' => is_string($curlbody) ? substr($curlbody, 0, 200) : null], JSON_PRETTY_PRINT);",
    },
  ]);

  try {
    await page.goto(`/?blueprint=${bp}`);
    await waitForPlaygroundReady(page);

    const result = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-external-https.php",
    );

    expect(result.moodle_playground).toBe(true);
    expect(result.url).toBe(
      "https://raw.githubusercontent.com/WordPress/wordpress-playground/5e5ba3e0f5b984ceadd5cbe6e661828c14621d25/README.md",
    );
    expect(result.fgc_ok).toBe(true);
    expect(result.fgc_body_prefix).toMatch(
      /WordPress Playground|PHP\.wasm|Playground/i,
    );
    expect(result.curl_errno).toBe(0);
    expect(result.curl_error).toBe("");
    expect(result.curl_http_code).toBe(200);
    expect(result.curl_body_prefix).toMatch(
      /WordPress Playground|PHP\.wasm|Playground/i,
    );
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("PHP direct HTTPS can fetch the eXeLearning GitHub releases feed", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName === "firefox");
  const diagnostics = createDiagnosticsCollector(page);
  const bp = buildNetworkingBlueprint("PHP GitHub Feed Direct Test", [
    {
      path: "/www/moodle/playground-net-github-feed-direct.php",
      literal: `<?php require(__DIR__ . '/config.php'); $url = '${EXELEARNING_RELEASES_ATOM_URL}'; $body = @file_get_contents($url); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 10]); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_body_prefix' => is_string($body) ? substr($body, 0, 200) : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_body_prefix' => is_string($curlbody) ? substr($curlbody, 0, 200) : null], JSON_PRETTY_PRINT);`,
    },
  ]);

  try {
    await page.goto(
      `/?blueprint=${bp}&phpCorsProxyUrl=${encodeURIComponent(localCorsProxyBaseUrl)}`,
    );
    await waitForPlaygroundReady(page);

    const result = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-github-feed-direct.php",
    );

    expect(result.moodle_playground).toBe(true);
    expect(result.url).toBe(EXELEARNING_RELEASES_ATOM_URL);
    expect(result.fgc_ok).toBe(true);
    expect(result.fgc_error).toBeNull();
    expect(result.fgc_body_prefix).toMatch(/<feed|<\?xml/i);
    expect(result.curl_errno).toBe(0);
    expect(result.curl_error).toBe("");
    expect(result.curl_http_code).toBe(200);
    expect(result.curl_body_prefix).toMatch(/<feed|<\?xml/i);
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("PHP direct HTTPS can fetch the eXeLearning GitHub release ZIP asset", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName === "firefox");
  const diagnostics = createDiagnosticsCollector(page);
  const bp = buildNetworkingBlueprint("PHP GitHub Asset Direct Test", [
    {
      path: "/www/moodle/playground-net-github-asset-direct.php",
      literal: `<?php require(__DIR__ . '/config.php'); $url = '${EXELEARNING_RELEASE_ASSET_URL}'; $context = stream_context_create(['http' => ['header' => "Range: bytes=0-3\\r\\n"]]); $body = @file_get_contents($url, false, $context); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_RANGE => '0-3']); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_prefix_hex' => is_string($body) ? bin2hex(substr($body, 0, 4)) : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_prefix_hex' => is_string($curlbody) ? bin2hex(substr($curlbody, 0, 4)) : null], JSON_PRETTY_PRINT);`,
    },
  ]);

  try {
    await page.goto(
      `/?blueprint=${bp}&phpCorsProxyUrl=${encodeURIComponent(localCorsProxyBaseUrl)}`,
    );
    await waitForPlaygroundReady(page);

    const result = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-github-asset-direct.php",
    );

    expect(result.moodle_playground).toBe(true);
    expect(result.url).toBe(EXELEARNING_RELEASE_ASSET_URL);
    expect(result.fgc_ok).toBe(true);
    expect(result.fgc_error).toBeNull();
    expect(result.fgc_prefix_hex).toBe("504b0304");
    expect(result.curl_errno).toBe(0);
    expect(result.curl_error).toBe("");
    expect([200, 206]).toContain(result.curl_http_code);
    expect(result.curl_prefix_hex).toBe("504b0304");
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("Firefox: PHP networking scenarios complete within three runtime boots", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "firefox");
  test.fixme(
    browserName === "firefox",
    "Temporarily disabled due to Firefox CI runtime readiness flakiness.",
  );
  const diagnostics = createDiagnosticsCollector(page);

  const defaultBlueprint = buildNetworkingBlueprint(
    "PHP Networking Firefox Default",
    [
      {
        path: "/www/moodle/playground-net-local-https.php",
        literal: `<?php require(__DIR__ . '/config.php'); $url = '${localHttpsBaseUrl}/plain'; $body = @file_get_contents($url); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 10]); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_body' => is_string($body) ? $body : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_body' => is_string($curlbody) ? $curlbody : null], JSON_PRETTY_PRINT);`,
      },
      {
        path: "/www/moodle/playground-net-external-https.php",
        literal:
          "<?php require(__DIR__ . '/config.php'); $url = 'https://raw.githubusercontent.com/WordPress/wordpress-playground/5e5ba3e0f5b984ceadd5cbe6e661828c14621d25/README.md'; $body = @file_get_contents($url); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 10]); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_body_prefix' => is_string($body) ? substr($body, 0, 200) : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_body_prefix' => is_string($curlbody) ? substr($curlbody, 0, 200) : null], JSON_PRETTY_PRINT);",
      },
    ],
  );
  const addonProxyBlueprint = buildNetworkingBlueprint(
    "PHP Networking Firefox Same-Origin Proxy",
    [
      {
        path: "/www/moodle/playground-net-github.php",
        literal:
          "<?php require(__DIR__ . '/config.php'); $base = defined('MOODLE_PLAYGROUND_PROXY_URL') && MOODLE_PLAYGROUND_PROXY_URL !== '' ? MOODLE_PLAYGROUND_PROXY_URL : rtrim($CFG->wwwroot, '/') . '/__playground_proxy__'; $url = $base . '?repo=exelearning%2Fexelearning&atom=releases'; $body = @file_get_contents($url); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 10]); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_body_prefix' => is_string($body) ? substr($body, 0, 200) : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_body_prefix' => is_string($curlbody) ? substr($curlbody, 0, 200) : null], JSON_PRETTY_PRINT);",
      },
    ],
  );
  const phpCorsBlueprint = buildNetworkingBlueprint(
    "PHP Networking Firefox CORS Proxy",
    [
      {
        path: "/www/moodle/playground-net-fallback.php",
        literal:
          "<?php require(__DIR__ . '/config.php'); $url = 'http://remote-server.example/plain'; $body = @file_get_contents($url); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 10]); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_body' => is_string($body) ? $body : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_body' => is_string($curlbody) ? $curlbody : null], JSON_PRETTY_PRINT);",
      },
      {
        path: "/www/moodle/playground-net-github-feed-direct.php",
        literal: `<?php require(__DIR__ . '/config.php'); $url = '${EXELEARNING_RELEASES_ATOM_URL}'; $body = @file_get_contents($url); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 10]); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_body_prefix' => is_string($body) ? substr($body, 0, 200) : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_body_prefix' => is_string($curlbody) ? substr($curlbody, 0, 200) : null], JSON_PRETTY_PRINT);`,
      },
      {
        path: "/www/moodle/playground-net-github-asset-direct.php",
        literal: `<?php require(__DIR__ . '/config.php'); $url = '${EXELEARNING_RELEASE_ASSET_URL}'; $context = stream_context_create(['http' => ['header' => "Range: bytes=0-3\\r\\n"]]); $body = @file_get_contents($url, false, $context); $fgcerror = error_get_last(); $ch = curl_init($url); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_RANGE => '0-3']); $curlbody = curl_exec($ch); $curlerrno = curl_errno($ch); $curlerror = curl_error($ch); $curlinfo = curl_getinfo($ch); curl_close($ch); header('Content-Type: application/json'); echo json_encode(['moodle_playground' => defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND, 'url' => $url, 'fgc_ok' => $body !== false, 'fgc_error' => $fgcerror['message'] ?? null, 'fgc_prefix_hex' => is_string($body) ? bin2hex(substr($body, 0, 4)) : null, 'curl_errno' => $curlerrno, 'curl_error' => $curlerror, 'curl_http_code' => $curlinfo['http_code'] ?? null, 'curl_prefix_hex' => is_string($curlbody) ? bin2hex(substr($curlbody, 0, 4)) : null], JSON_PRETTY_PRINT);`,
      },
    ],
  );

  try {
    await page.goto(`/?blueprint=${defaultBlueprint}`);
    await waitForRuntimeFrameReady(page);

    const localHttpsResult = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-local-https.php",
    );
    expect(localHttpsResult.moodle_playground).toBe(true);
    expect(localHttpsResult.url).toBe(`${localHttpsBaseUrl}/plain`);
    expect(localHttpsResult.fgc_ok).toBe(false);
    expect(localHttpsResult.fgc_error).toMatch(
      /Failed to open stream: operation failed/,
    );
    expect(localHttpsResult.fgc_body).toBeNull();
    expect(localHttpsResult.curl_errno).toBe(35);
    expect(localHttpsResult.curl_error).toMatch(
      /SSL_ERROR_SYSCALL|UnknownCa|ASN1/i,
    );
    expect(localHttpsResult.curl_http_code).toBe(0);
    expect(localHttpsResult.curl_body).toBeNull();

    const externalResult = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-external-https.php",
    );
    expect(externalResult.moodle_playground).toBe(true);
    expect(externalResult.fgc_ok).toBe(true);
    expect(externalResult.fgc_body_prefix).toMatch(
      /WordPress Playground|PHP\.wasm|Playground/i,
    );
    expect(externalResult.curl_errno).toBe(0);
    expect(externalResult.curl_error).toBe("");
    expect(externalResult.curl_http_code).toBe(200);
    expect(externalResult.curl_body_prefix).toMatch(
      /WordPress Playground|PHP\.wasm|Playground/i,
    );

    await page.goto(
      `/?blueprint=${addonProxyBlueprint}&addonProxyUrl=${encodeURIComponent(localAddonProxyBaseUrl)}`,
    );
    await waitForRuntimeFrameReady(page);

    const sameOriginProxyResult = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-github.php",
    );
    expect(sameOriginProxyResult.moodle_playground).toBe(true);
    expect(sameOriginProxyResult.url).toContain(
      "/__playground_proxy__?repo=exelearning%2Fexelearning&atom=releases",
    );
    expect(sameOriginProxyResult.fgc_ok).toBe(true);
    expect(sameOriginProxyResult.fgc_body_prefix).toMatch(/<feed|<\?xml/i);
    expect(sameOriginProxyResult.curl_errno).toBe(0);
    expect(sameOriginProxyResult.curl_http_code).toBe(200);
    expect(sameOriginProxyResult.curl_body_prefix).toMatch(/<feed|<\?xml/i);

    await page.goto(
      `/?blueprint=${phpCorsBlueprint}&phpCorsProxyUrl=${encodeURIComponent(localCorsProxyBaseUrl)}`,
    );
    await waitForRuntimeFrameReady(page);

    const fallbackResult = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-fallback.php",
    );
    expect(fallbackResult.moodle_playground).toBe(true);
    expect(fallbackResult.url).toBe("http://remote-server.example/plain");
    expect(fallbackResult.fgc_ok).toBe(true);
    expect(fallbackResult.fgc_body).toBe("proxy-fallback-ok");
    expect(fallbackResult.curl_errno).toBe(0);
    expect(fallbackResult.curl_http_code).toBe(200);
    expect(fallbackResult.curl_body).toBe("proxy-fallback-ok");
    expect(
      localCorsProxyHits
        .filter(
          ({ target }) => target === "https://remote-server.example/plain",
        )
        .map(({ method, target }) => ({ method, target })),
    ).toEqual([
      { method: "GET", target: "https://remote-server.example/plain" },
      { method: "GET", target: "https://remote-server.example/plain" },
    ]);

    const directFeedResult = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-github-feed-direct.php",
    );
    expect(directFeedResult.moodle_playground).toBe(true);
    expect(directFeedResult.url).toBe(EXELEARNING_RELEASES_ATOM_URL);
    expect(directFeedResult.fgc_ok).toBe(true);
    expect(directFeedResult.fgc_error).toBeNull();
    expect(directFeedResult.fgc_body_prefix).toMatch(/<feed|<\?xml/i);
    expect(directFeedResult.curl_errno).toBe(0);
    expect(directFeedResult.curl_error).toBe("");
    expect(directFeedResult.curl_http_code).toBe(200);
    expect(directFeedResult.curl_body_prefix).toMatch(/<feed|<\?xml/i);

    const directAssetResult = await fetchPhpJson(
      page,
      "/playground/main/php83-moodle50/playground-net-github-asset-direct.php",
    );
    expect(directAssetResult.moodle_playground).toBe(true);
    expect(directAssetResult.url).toBe(EXELEARNING_RELEASE_ASSET_URL);
    expect(directAssetResult.fgc_ok).toBe(true);
    expect(directAssetResult.fgc_error).toBeNull();
    expect(directAssetResult.fgc_prefix_hex).toBe("504b0304");
    expect(directAssetResult.curl_errno).toBe(0);
    expect(directAssetResult.curl_error).toBe("");
    expect([200, 206]).toContain(directAssetResult.curl_http_code);
    expect(directAssetResult.curl_prefix_hex).toBe("504b0304");
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});
