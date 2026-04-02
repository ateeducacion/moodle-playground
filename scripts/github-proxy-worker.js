// Cloudflare Worker that acts as a GitHub proxy for archive files and Atom feeds.
//
// Supports two modes:
//
// 1. Generic proxy mode (legacy): ?url={full_url}
//    Proxies supported direct URLs with CORS headers. This includes ZIP downloads,
//    GitHub-hosted text/binary resources, and FacturaScripts plugin pages.
//
// 2. GitHub proxy mode: ?repo={owner/repo}[&branch=...][&pr=...][&commit=...][&release=...][&asset=...][&atom=...]
//    Builds the correct GitHub URL from semantic parameters and proxies the response.
//
// Environment variables (optional):
//   GITHUB_TOKEN – A GitHub personal access token to raise API rate limits from 60 to 5000 req/hour.

const GITHUB_API = "https://api.github.com";
const GITHUB_BASE = "https://github.com";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(
        { error: "Method not allowed. Only GET is supported." },
        405,
      );
    }

    const params = new URL(request.url).searchParams;

    // Legacy generic proxy mode
    if (params.has("url")) {
      return handleGenericProxy(params.get("url"), request, env);
    }

    // GitHub proxy mode
    if (params.has("repo")) {
      return handleGitHubProxy(params, env);
    }

    // If the request accepts HTML (browser), serve the landing page.
    // Otherwise (curl, fetch, etc.) return JSON usage info.
    const acceptHeader = request.headers.get("Accept") || "";

    if (acceptHeader.includes("text/html")) {
      return new Response(landingPageHtml(new URL(request.url).origin), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return jsonResponse(
      {
        error: "Missing parameters. Provide either ?url= or ?repo=.",
        usage: {
          generic: "?url={full_url}",
          branch: "?repo={owner/repo}[&branch={branch}]",
          pr: "?repo={owner/repo}&pr={number}",
          commit: "?repo={owner/repo}&commit={sha}",
          release: "?repo={owner/repo}&release={tag}",
          asset: "?repo={owner/repo}&release={tag}&asset={filename}",
          atom_releases: "?repo={owner/repo}&atom=releases",
          atom_tags: "?repo={owner/repo}&atom=tags",
        },
      },
      400,
    );
  },
};

// ---------------------------------------------------------------------------
// GitHub proxy mode
// ---------------------------------------------------------------------------

async function handleGitHubProxy(params, env) {
  const repo = params.get("repo");

  if (!repo?.includes("/")) {
    return jsonResponse({ error: "Invalid repo format. Use owner/repo." }, 400);
  }

  // Atom feeds
  if (params.has("atom")) {
    return handleAtomFeed(repo, params.get("atom"));
  }

  // Release asset
  if (params.has("release") && params.has("asset")) {
    return handleReleaseAsset(
      repo,
      params.get("release"),
      params.get("asset"),
      env,
    );
  }

  // Full release ZIP
  if (params.has("release")) {
    return proxyGitHubZip(
      `${GITHUB_BASE}/${repo}/archive/refs/tags/${params.get("release")}.zip`,
    );
  }

  // Specific commit
  if (params.has("commit")) {
    return proxyGitHubZip(
      `${GITHUB_BASE}/${repo}/archive/${params.get("commit")}.zip`,
    );
  }

  // Pull request
  if (params.has("pr")) {
    return handlePullRequest(repo, params.get("pr"), env);
  }

  // Branch (or default branch)
  const branch = params.get("branch");

  if (branch) {
    return proxyGitHubZip(
      `${GITHUB_BASE}/${repo}/archive/refs/heads/${branch}.zip`,
    );
  }

  // No branch specified – resolve the default branch via the API
  const defaultBranch = await getDefaultBranch(repo, env);

  if (!defaultBranch) {
    return jsonResponse(
      {
        error:
          "Could not determine the default branch. Check that the repo exists and is public.",
      },
      502,
    );
  }

  return proxyGitHubZip(
    `${GITHUB_BASE}/${repo}/archive/refs/heads/${defaultBranch}.zip`,
  );
}

// ---------------------------------------------------------------------------
// Atom feeds
// ---------------------------------------------------------------------------

async function handleAtomFeed(repo, type) {
  const validTypes = ["releases", "tags"];

  if (!validTypes.includes(type)) {
    return jsonResponse(
      { error: `Invalid atom type. Use one of: ${validTypes.join(", ")}` },
      400,
    );
  }

  const url = `${GITHUB_BASE}/${repo}/${type}.atom`;

  try {
    const upstream = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "github-proxy-worker" },
    });

    if (!upstream.ok) {
      return jsonResponse(
        {
          error: "Upstream server returned an error.",
          status: upstream.status,
          statusText: upstream.statusText,
        },
        502,
      );
    }

    const headers = new Headers();

    applyCorsHeaders(headers);
    headers.set("Content-Type", "application/atom+xml; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=300");

    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    return jsonResponse(
      { error: "Failed to fetch Atom feed.", details: error.message },
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Pull request resolution
// ---------------------------------------------------------------------------

async function handlePullRequest(repo, prNumber, env) {
  const apiUrl = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}`;
  const data = await githubApiRequest(apiUrl, env);

  if (!data?.head?.sha) {
    return jsonResponse(
      { error: `Could not resolve PR #${prNumber}. Check that it exists.` },
      502,
    );
  }

  return proxyGitHubZip(`${GITHUB_BASE}/${repo}/archive/${data.head.sha}.zip`);
}

// ---------------------------------------------------------------------------
// Release asset resolution
// ---------------------------------------------------------------------------

async function handleReleaseAsset(repo, tag, assetName, env, request = null) {
  const apiUrl = `${GITHUB_API}/repos/${repo}/releases/tags/${tag}`;
  const data = await githubApiRequest(apiUrl, env);

  if (!data?.assets) {
    return jsonResponse(
      {
        error: `Could not find release "${tag}".`,
        upstream_status: 404,
        upstream_status_text: "Not Found",
      },
      502,
    );
  }

  const asset = data.assets.find(
    (a) => a.name.toLowerCase() === assetName.toLowerCase(),
  );

  if (!asset) {
    const available = data.assets.map((a) => a.name);

    return jsonResponse(
      {
        error: `Asset "${assetName}" not found in release "${tag}".`,
        available_assets: available,
      },
      404,
    );
  }

  return proxyGitHubZip(asset.browser_download_url, {
    request,
    downloadFilename: asset.name,
  });
}

// ---------------------------------------------------------------------------
// Default branch resolution
// ---------------------------------------------------------------------------

async function getDefaultBranch(repo, env) {
  const data = await githubApiRequest(`${GITHUB_API}/repos/${repo}`, env);

  return data ? data.default_branch : null;
}

// ---------------------------------------------------------------------------
// GitHub API helper
// ---------------------------------------------------------------------------

async function githubApiRequest(url, env) {
  const headers = {
    "User-Agent": "github-proxy-worker",
    Accept: "application/vnd.github+json",
  };

  const token = env?.GITHUB_TOKEN;

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ZIP proxy (shared by all archive downloads)
// ---------------------------------------------------------------------------

async function proxyGitHubZip(
  url,
  { request = null, downloadFilename = null } = {},
) {
  try {
    const headers = new Headers({
      "User-Agent": "github-proxy-worker",
      Accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    });

    const forwardedRange = request?.headers?.get("Range");
    if (forwardedRange) {
      headers.set("Range", forwardedRange);
    }

    const upstream = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers,
    });

    if (!upstream.ok) {
      return jsonResponse(
        {
          error: "Upstream server returned an error.",
          status: upstream.status,
          statusText: upstream.statusText,
          upstream_url: url,
        },
        502,
      );
    }

    const responseHeaders = new Headers(upstream.headers);

    applyCorsHeaders(responseHeaders);
    responseHeaders.set(
      "Content-Type",
      responseHeaders.get("Content-Type") || "application/zip",
    );

    if (!responseHeaders.get("Content-Disposition")) {
      const filename = downloadFilename || buildZipFilename(new URL(url));
      responseHeaders.set(
        "Content-Disposition",
        `attachment; filename="${sanitizeFilename(filename)}"`,
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return jsonResponse(
      { error: "Failed to fetch remote resource.", details: error.message },
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Legacy generic proxy mode
// ---------------------------------------------------------------------------

async function handleGenericProxy(targetUrl, request, env) {
  let parsedUrl;

  try {
    parsedUrl = new URL(targetUrl);
  } catch (error) {
    return jsonResponse({ error: "Invalid URL.", details: error.message }, 400);
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return jsonResponse(
      { error: "Invalid protocol. Only http and https are allowed." },
      400,
    );
  }

  if (!isSupportedGenericProxyUrl(parsedUrl)) {
    return jsonResponse(
      {
        error:
          "The provided URL is not a supported direct GitHub/resource URL.",
      },
      400,
    );
  }

  const translatedGitHubResponse = await maybeHandleDirectGitHubUrl(
    parsedUrl,
    env,
    request,
  );
  if (translatedGitHubResponse) {
    return translatedGitHubResponse;
  }

  try {
    const upstreamHeaders = buildGenericProxyRequestHeaders(parsedUrl, request);

    const upstream = await fetch(parsedUrl.toString(), {
      method: "GET",
      redirect: "follow",
      headers: upstreamHeaders,
    });

    if (!upstream.ok) {
      return jsonResponse(
        {
          error: "Upstream server returned an error.",
          status: upstream.status,
          statusText: upstream.statusText,
        },
        502,
      );
    }

    const headers = new Headers(upstream.headers);

    applyCorsHeaders(headers);
    headers.set(
      "Content-Type",
      headers.get("Content-Type") || defaultGenericContentType(parsedUrl),
    );

    if (!headers.get("Content-Disposition") && looksLikeZipUrl(parsedUrl)) {
      headers.set(
        "Content-Disposition",
        `attachment; filename="${buildZipFilename(parsedUrl)}"`,
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    return jsonResponse(
      { error: "Failed to fetch remote resource.", details: error.message },
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Expose-Headers":
      "Content-Disposition, Content-Type, Content-Length, X-Playground-Cors-Proxy",
    "Access-Control-Max-Age": "86400",
    "X-Playground-Cors-Proxy": "true",
  };
}

function applyCorsHeaders(headers) {
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function looksLikeZipUrl(url) {
  const pathname = url.pathname.toLowerCase();

  if (pathname.endsWith(".zip")) return true;
  if (pathname.includes("/zip/")) return true;
  if (pathname.includes("archive/refs/heads/")) return true;
  if (pathname.includes("archive/refs/tags/")) return true;
  if (/\/downloadbuild\/\d+\/(stable|beta)$/u.test(pathname)) return true;

  return false;
}

function isSupportedGenericProxyUrl(url) {
  return (
    looksLikeZipUrl(url) ||
    isFacturaScriptsPluginPage(url) ||
    isGitHubDirectProxyUrl(url)
  );
}

function isGitHubDirectProxyUrl(url) {
  const hostname = url.hostname.toLowerCase();

  if (
    hostname === "github.com" ||
    hostname === "raw.githubusercontent.com" ||
    hostname === "gist.githubusercontent.com" ||
    hostname === "media.githubusercontent.com" ||
    hostname === "objects.githubusercontent.com" ||
    hostname === "release-assets.githubusercontent.com" ||
    hostname.endsWith(".githubusercontent.com")
  ) {
    return true;
  }

  return false;
}

async function maybeHandleDirectGitHubUrl(url, env, request) {
  const repoMatch = matchGitHubRepoPath(url.pathname);
  if (!repoMatch) {
    return null;
  }

  const { repo, suffix } = repoMatch;

  if (suffix === "/releases.atom") {
    return handleAtomFeed(repo, "releases");
  }

  if (suffix === "/tags.atom") {
    return handleAtomFeed(repo, "tags");
  }

  const releaseAssetMatch = suffix.match(
    /^\/releases\/download\/([^/]+)\/([^/]+)$/u,
  );
  if (releaseAssetMatch) {
    const [, tag, assetName] = releaseAssetMatch;
    return handleReleaseAsset(
      repo,
      decodeURIComponent(tag),
      decodeURIComponent(assetName),
      env,
      request,
    );
  }

  return null;
}

function matchGitHubRepoPath(pathname) {
  const match = pathname.match(/^\/([^/]+\/[^/]+)(\/.*)$/u);
  if (!match) {
    return null;
  }

  return {
    repo: match[1],
    suffix: match[2],
  };
}

function buildGenericProxyRequestHeaders(url, request) {
  const headers = new Headers();
  headers.set("User-Agent", "github-proxy-worker");
  headers.set("Cache-Control", "no-cache");
  headers.set("Pragma", "no-cache");

  const forwardedAccept = request.headers.get("Accept");
  headers.set("Accept", forwardedAccept || defaultGenericAcceptHeader(url));

  const forwardedRange = request.headers.get("Range");
  if (forwardedRange) {
    headers.set("Range", forwardedRange);
  }

  const forwardedIfNoneMatch = request.headers.get("If-None-Match");
  if (forwardedIfNoneMatch) {
    headers.set("If-None-Match", forwardedIfNoneMatch);
  }

  const forwardedIfModifiedSince = request.headers.get("If-Modified-Since");
  if (forwardedIfModifiedSince) {
    headers.set("If-Modified-Since", forwardedIfModifiedSince);
  }

  return headers;
}

function defaultGenericAcceptHeader(url) {
  if (isFacturaScriptsPluginPage(url)) {
    return "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
  }

  if (looksLikeZipUrl(url)) {
    return "application/zip, application/octet-stream;q=0.9, */*;q=0.8";
  }

  if (url.pathname.toLowerCase().endsWith(".atom")) {
    return "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7";
  }

  return "application/octet-stream, text/plain;q=0.9, */*;q=0.8";
}

function defaultGenericContentType(url) {
  if (looksLikeZipUrl(url)) {
    return "application/zip";
  }

  if (url.pathname.toLowerCase().endsWith(".atom")) {
    return "application/atom+xml; charset=utf-8";
  }

  if (isFacturaScriptsPluginPage(url)) {
    return "text/html; charset=utf-8";
  }

  return "application/octet-stream";
}

function isFacturaScriptsPluginPage(url) {
  return (
    url.hostname.toLowerCase() === "facturascripts.com" &&
    /^\/plugins\/[^/]+\/?$/u.test(url.pathname)
  );
}

function buildZipFilename(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "download.zip";

  if (last.toLowerCase().endsWith(".zip")) {
    return sanitizeFilename(last);
  }

  return sanitizeFilename(`${last}.zip`);
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

function landingPageHtml(origin) {
  const base = origin || "https://your-worker.workers.dev";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub Proxy</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #ffffff;
    --surface: #f6f8fa;
    --surface-hover: #eef1f5;
    --border: #d0d7de;
    --text: #1f2328;
    --text-muted: #656d76;
    --accent: #0969da;
    --accent-glow: rgba(9, 105, 218, 0.08);
    --green: #1a7f37;
    --orange: #9a6700;
    --red: #cf222e;
    --mono: 'JetBrains Mono', monospace;
    --sans: 'DM Sans', system-ui, sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    line-height: 1.6;
  }

  .hero {
    text-align: center;
    padding: 5rem 1.5rem 3rem;
    position: relative;
  }

  .hero::before {
    content: '';
    position: absolute;
    top: 0; left: 50%;
    transform: translateX(-50%);
    width: 600px; height: 600px;
    background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%);
    pointer-events: none;
    z-index: 0;
  }

  .hero > * { position: relative; z-index: 1; }

  .logo {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .logo svg {
    width: 48px; height: 48px;
    color: var(--accent);
  }

  h1 {
    font-family: var(--mono);
    font-size: clamp(2rem, 5vw, 3.5rem);
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 0.75rem;
  }

  .subtitle {
    color: var(--text-muted);
    font-size: 1.15rem;
    max-width: 600px;
    margin: 0 auto 1.5rem;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 2rem;
    padding: 0.4rem 1rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .badge a {
    color: var(--accent);
    text-decoration: none;
  }

  .badge a:hover { text-decoration: underline; }

  .container {
    max-width: 820px;
    margin: 0 auto;
    padding: 0 1.5rem 4rem;
    flex: 1;
  }

  .section-title {
    font-family: var(--mono);
    font-size: 0.8rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent);
    margin-bottom: 1.25rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .endpoints {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 3rem;
  }

  .endpoint {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.25rem;
    transition: border-color 0.2s, background 0.2s;
    cursor: default;
  }

  .endpoint:hover {
    border-color: var(--accent);
    background: var(--surface-hover);
  }

  .endpoint-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .method {
    font-family: var(--mono);
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    background: rgba(26, 127, 55, 0.1);
    color: var(--green);
    flex-shrink: 0;
  }

  .endpoint-name {
    font-family: var(--mono);
    font-weight: 500;
    font-size: 0.95rem;
  }

  .endpoint-desc {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-left: calc(0.7rem + 0.5rem * 2 + 0.75rem); /* align with name */
  }

  .url-box {
    font-family: var(--mono);
    font-size: 0.8rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.6rem 0.9rem;
    margin-top: 0.5rem;
    margin-left: calc(0.7rem + 0.5rem * 2 + 0.75rem);
    color: var(--text-muted);
    overflow-x: auto;
    white-space: nowrap;
    user-select: all;
  }

  .url-box .param {
    color: var(--orange);
  }

  .url-box .optional {
    color: var(--text-muted);
    opacity: 0.6;
  }

  footer {
    text-align: center;
    padding: 2rem 1.5rem;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  footer a {
    color: var(--accent);
    text-decoration: none;
  }

  footer a:hover { text-decoration: underline; }

  @media (max-width: 640px) {
    .hero { padding: 3rem 1rem 2rem; }
    .endpoint-desc, .url-box { margin-left: 0; }
  }
</style>
</head>
<body>

<div class="hero">
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
    </svg>
    <span style="font-family:var(--mono);font-size:1.1rem;font-weight:700;color:var(--text-muted)">PROXY</span>
  </div>
  <h1>GitHub Proxy</h1>
  <p class="subtitle">
    A CORS-friendly proxy for GitHub archive files, release assets and Atom feeds.
    Intended as a drop-in replacement for <code style="color:var(--accent)">github-proxy.com</code>.
  </p>
  <div class="badge">
    &#x1F4D6; Background:
    <a href="https://make.wordpress.org/playground/2025/12/19/action-required-github-proxy-com-shutdown/" target="_blank" rel="noopener">
      github-proxy.com shutdown notice
    </a>
  </div>
</div>

<div class="container">
  <div class="section-title">Archive Downloads</div>
  <div class="endpoints">

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Branch</span>
      </div>
      <div class="endpoint-desc">Download a full branch. Resolves the default branch when none is specified.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span><span class="optional">[&amp;branch=<span class="param">{branch}</span>]</span></div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Pull Request</span>
      </div>
      <div class="endpoint-desc">Download the code for a pull request by its number.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;pr=<span class="param">{number}</span></div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Commit</span>
      </div>
      <div class="endpoint-desc">Download the code at a specific commit SHA.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;commit=<span class="param">{sha}</span></div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Release</span>
      </div>
      <div class="endpoint-desc">Download the source archive for a tagged release.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;release=<span class="param">{tag}</span></div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Release Asset</span>
      </div>
      <div class="endpoint-desc">Download a specific asset file attached to a release.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;release=<span class="param">{tag}</span>&amp;asset=<span class="param">{filename}</span></div>
    </div>

  </div>

  <div class="section-title">Atom Feeds</div>
  <div class="endpoints">

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Releases Feed</span>
      </div>
      <div class="endpoint-desc">Atom feed of a repository's releases.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;atom=<span class="param">releases</span></div>
    </div>

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">Tags Feed</span>
      </div>
      <div class="endpoint-desc">Atom feed of a repository's tags.</div>
      <div class="url-box">${base}/?repo=<span class="param">{owner/repo}</span>&amp;atom=<span class="param">tags</span></div>
    </div>

  </div>

  <div class="section-title">Generic Proxy (Legacy)</div>
  <div class="endpoints">

    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method">GET</span>
        <span class="endpoint-name">URL Proxy</span>
      </div>
      <div class="endpoint-desc">Proxy any ZIP download URL with CORS headers.</div>
      <div class="url-box">${base}/?url=<span class="param">{full_url}</span></div>
    </div>

  </div>
</div>

<footer>
  Built as an alternative after the
  <a href="https://make.wordpress.org/playground/2025/12/19/action-required-github-proxy-com-shutdown/" target="_blank" rel="noopener">github-proxy.com shutdown</a>.
  Powered by <a href="https://workers.cloudflare.com/" target="_blank" rel="noopener">Cloudflare Workers</a>.
</footer>

</body>
</html>`;
}
