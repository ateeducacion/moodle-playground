/**
 * Plugin installation steps: installMoodlePlugin, installTheme.
 *
 * Downloads plugin ZIPs, writes them to the correct Moodle plugin directory,
 * and runs the Moodle upgrade to register the plugin.
 */

import { readZipEntries } from "../../../lib/moodle-loader.js";

const MOODLE_ROOT = "/www/moodle";
const DEFAULT_ADDON_PROXY_URL = "https://github-proxy.exelearning.dev/";

// Map Moodle plugin types to their directory under MOODLE_ROOT
const PLUGIN_TYPE_DIRS = {
  mod: "mod",
  block: "blocks",
  local: "local",
  theme: "theme",
  auth: "auth",
  enrol: "enrol",
  filter: "filter",
  format: "course/format",
  report: "report",
  tool: "admin/tool",
  editor: "lib/editor",
  atto: "lib/editor/atto/plugins",
  tiny: "lib/editor/tiny/plugins",
  qtype: "question/type",
  qbehaviour: "question/behaviour",
  gradeexport: "grade/export",
  gradeimport: "grade/import",
  gradereport: "grade/report",
  repository: "repository",
  plagiarism: "plagiarism",
  availability: "availability/condition",
  calendartype: "calendar/type",
  message: "message/output",
  profilefield: "user/profile/field",
  datafield: "mod/data/field",
  assignsubmission: "mod/assign/submission",
  assignfeedback: "mod/assign/feedback",
  booktool: "mod/book/tool",
  quizaccess: "mod/quiz/accessrule",
  ltisource: "mod/lti/source",
  workshopform: "mod/workshop/form",
  workshopallocation: "mod/workshop/allocation",
  workshopeval: "mod/workshop/eval",
  contenttype: "contentbank/contenttype",
  customfield: "customfield/field",
  media: "media/player",
  paygw: "payment/gateway",
  qbank: "question/bank",
  search: "search/engine",
  aiprovider: "ai/provider",
  aiplacement: "ai/placement",
};

export function registerMoodlePluginSteps(register) {
  register("installMoodlePlugin", handleInstallMoodlePlugin);
  register("installTheme", handleInstallTheme);
}

async function handleInstallMoodlePlugin(step, context) {
  if (!step.url) {
    throw new Error("installMoodlePlugin: 'url' is required.");
  }

  // Auto-detect pluginType and pluginName from the URL if not provided.
  // GitHub repos follow the convention: moodle-{type}_{name}
  const detected = detectPluginTypeAndName(step.url);
  const pluginType = step.pluginType || detected.type;
  const pluginName = step.pluginName || detected.name;

  if (!pluginType) {
    throw new Error(
      "installMoodlePlugin: 'pluginType' could not be detected from URL. Provide it explicitly.",
    );
  }
  if (!pluginName) {
    throw new Error(
      "installMoodlePlugin: 'pluginName' could not be detected from URL. Provide it explicitly.",
    );
  }

  const targetDir = resolvePluginDir(pluginType, pluginName, context.webRoot);
  await installPluginFiles(step.url, targetDir, context);
  await runMoodleUpgrade(pluginType, pluginName, targetDir, context);
  context.onPluginInstalled?.(targetDir);
}

async function handleInstallTheme(step, context) {
  if (!step.url) {
    throw new Error("installTheme: 'url' is required.");
  }

  const detected = detectPluginTypeAndName(step.url);
  const pluginName = step.pluginName || detected.name;
  if (!pluginName) {
    throw new Error(
      "installTheme: 'pluginName' could not be detected from URL. Provide it explicitly.",
    );
  }

  const targetDir = resolvePluginDir("theme", pluginName, context.webRoot);
  await installPluginFiles(step.url, targetDir, context);
  await runMoodleUpgrade("theme", pluginName, targetDir, context);
  context.onPluginInstalled?.(targetDir);
}

function resolvePluginDir(pluginType, pluginName, webRoot) {
  const typeDir = PLUGIN_TYPE_DIRS[pluginType];
  if (!typeDir) {
    throw new Error(
      `Unknown plugin type '${pluginType}'. Known types: ${Object.keys(PLUGIN_TYPE_DIRS).join(", ")}`,
    );
  }
  const base = webRoot || MOODLE_ROOT;
  return `${base}/${typeDir}/${pluginName}`;
}

/**
 * Install plugin files to the target directory.
 * GitHub archive ZIPs are fetched through a configurable proxy to avoid
 * browser CORS issues and to support refs that contain `/`.
 */
async function installPluginFiles(url, targetDir, context) {
  const githubInfo = parseGitHubUrl(url);
  if (githubInfo) {
    await installViaZipDownload(url, targetDir, context);
  } else {
    await installViaZipDownload(url, targetDir, context);
  }
}

/**
 * Parse a GitHub URL to extract owner, repo, and ref.
 * Supports:
 *   https://github.com/owner/repo/archive/refs/heads/branch.zip
 *   https://github.com/owner/repo/archive/branch.zip
 */
function parseGitHubUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;

    // /owner/repo/archive/refs/heads/branch.zip
    const refsMatch = parsed.pathname.match(
      /^\/([^/]+)\/([^/]+)\/archive\/refs\/heads\/(.+)\.zip$/,
    );
    if (refsMatch) {
      return { owner: refsMatch[1], repo: refsMatch[2], ref: refsMatch[3] };
    }

    // /owner/repo/archive/refs/tags/tag.zip
    const tagsMatch = parsed.pathname.match(
      /^\/([^/]+)\/([^/]+)\/archive\/refs\/tags\/(.+)\.zip$/,
    );
    if (tagsMatch) {
      return { owner: tagsMatch[1], repo: tagsMatch[2], ref: tagsMatch[3] };
    }

    // /owner/repo/archive/branch.zip
    const simpleMatch = parsed.pathname.match(
      /^\/([^/]+)\/([^/]+)\/archive\/(.+)\.zip$/,
    );
    if (simpleMatch) {
      return {
        owner: simpleMatch[1],
        repo: simpleMatch[2],
        ref: simpleMatch[3],
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function installViaZipDownload(zipUrl, targetDir, context) {
  const { php, publish } = context;
  const downloadUrl = resolvePluginZipDownloadUrl(zipUrl, context);
  if (publish) {
    publish(
      downloadUrl === zipUrl
        ? `Downloading plugin ZIP from ${zipUrl}`
        : `Downloading plugin ZIP from ${zipUrl} via addon proxy`,
      0.93,
    );
  }

  // Retry once on 502/503 — Cloudflare CDN or GitHub may return transient
  // errors on browser reloads (cache revalidation race with the proxy).
  let response = await fetch(downloadUrl, { cache: "no-store" });
  if (!response.ok && (response.status === 502 || response.status === 503)) {
    if (publish) publish("Plugin download failed, retrying…", 0.93);
    await new Promise((r) => setTimeout(r, 1000));
    response = await fetch(downloadUrl, { cache: "no-store" });
  }
  if (!response.ok) {
    throw new Error(
      `Failed to download plugin ZIP from ${downloadUrl}: ${response.status}`,
    );
  }
  const zipBytes = new Uint8Array(await response.arrayBuffer());

  if (publish) publish(`Extracting plugin to ${targetDir}`, 0.935);

  const rawEntries = await readZipEntries(zipBytes);

  // GitHub ZIPs have a top-level directory. Find and strip common prefix.
  const paths = rawEntries.map((e) => e.path);
  const commonPrefix = findCommonPrefix(paths);

  const rawPhp = php._php;
  rawPhp.mkdirTree(targetDir);

  let fileCount = 0;
  for (const { path: entryPath, data: entryData } of rawEntries) {
    const relativePath = commonPrefix
      ? entryPath.substring(commonPrefix.length)
      : entryPath;
    if (!relativePath) continue;

    const fullPath = `${targetDir}/${relativePath}`;
    const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (parentDir && parentDir !== targetDir) {
      rawPhp.mkdirTree(parentDir);
    }

    rawPhp.writeFile(fullPath, entryData);
    fileCount++;
  }

  if (publish) publish(`Extracted ${fileCount} files to ${targetDir}`, 0.94);
}

/**
 * Run Moodle's upgrade process to register the newly installed plugin.
 */
async function runMoodleUpgrade(
  pluginType,
  pluginName,
  targetDir,
  { php, publish, webRoot },
) {
  if (publish) publish("Running Moodle upgrade to register plugin.", 0.945);

  const component = `${pluginType}_${pluginName}`;
  const safeDir = targetDir.replaceAll("'", "\\'");

  const base = webRoot || MOODLE_ROOT;
  const code = `<?php
define('CLI_SCRIPT', true);
require('${base}/config.php');
require_once($CFG->libdir . '/upgradelib.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->libdir . '/adminlib.php');

// Register the plugin in the alternative_component_cache.
// This writes the updated cache file so core_component sees the new plugin.
\\core_component::playground_refresh_installed_plugin_cache('${component}', '${safeDir}');

// Reset clears in-memory state; next init() re-reads the updated cache file.
\\core_component::reset();
if (function_exists('purge_all_caches')) {
    purge_all_caches();
}

// Force upgrade detection by clearing the stored hash.
set_config('allversionshash', '');

// Run the upgrade unconditionally.
try {
    upgrade_noncore(true);
    echo json_encode(['ok' => true]);
} catch (\\Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
`;

  let result;
  try {
    result = await php.run(code);
  } catch (err) {
    // php.run() throws on non-zero exit code (e.g. Moodle's
    // default_exception_handler calls exit(1) before our PHP catch runs).
    // Log the error but don't fail the blueprint step — the plugin files
    // are already installed and may work even without a full upgrade.
    if (publish)
      publish(
        `Plugin upgrade crashed: ${String(err.message || err).slice(0, 200)}`,
        0.95,
      );
    return;
  }
  const text = result?.text || "";
  const errors = result?.errors || "";
  if (errors && publish) {
    publish(`Plugin upgrade errors: ${errors.slice(0, 300)}`, 0.95);
  }
  if (text.includes('"ok":false') && publish) {
    publish(`Plugin upgrade failed: ${text.slice(0, 200)}`, 0.95);
  }
}

/**
 * Detect plugin type and name from a URL.
 *
 * GitHub repos follow the convention: moodle-{type}_{name}
 * Examples:
 *   moodle-mod_board       → { type: "mod",   name: "board" }
 *   moodle-block_participants → { type: "block", name: "participants" }
 *   moodle-local_staticpage   → { type: "local", name: "staticpage" }
 *
 * @param {string} url
 * @returns {{ type: string|null, name: string|null }}
 */
function detectPluginTypeAndName(url) {
  try {
    const pathname = new URL(url).pathname;
    const repoMatch = pathname.match(/\/([^/]+)\/archive\//);
    if (repoMatch) {
      const repoName = repoMatch[1].replace(/^moodle-/i, "");
      // Try to split on underscore: type_name
      const underscoreIdx = repoName.indexOf("_");
      if (underscoreIdx > 0) {
        const candidateType = repoName.substring(0, underscoreIdx);
        const candidateName = repoName.substring(underscoreIdx + 1);
        if (PLUGIN_TYPE_DIRS[candidateType] && candidateName) {
          return { type: candidateType, name: candidateName };
        }
      }
      // No recognized type prefix — return name only
      return { type: null, name: repoName || null };
    }
  } catch {
    // not a valid URL
  }
  return { type: null, name: null };
}

function findCommonPrefix(paths) {
  if (paths.length === 0) return "";
  const firstSlash = paths[0].indexOf("/");
  if (firstSlash < 0) return "";
  const candidate = paths[0].substring(0, firstSlash + 1);
  if (paths.every((p) => p.startsWith(candidate))) return candidate;
  return "";
}

function resolvePluginZipDownloadUrl(zipUrl, context = {}) {
  const proxyBase = resolveAddonProxyUrl(context);
  if (!proxyBase || !shouldProxyZipUrl(zipUrl)) {
    return zipUrl;
  }

  try {
    const proxied = new URL(proxyBase);
    proxied.searchParams.set("url", zipUrl);
    return proxied.toString();
  } catch {
    return zipUrl;
  }
}

function resolveAddonProxyUrl(context = {}) {
  const configured =
    context.addonProxyUrl ||
    context.config?.addonProxyUrl ||
    DEFAULT_ADDON_PROXY_URL;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : "";
}

function shouldProxyZipUrl(zipUrl) {
  try {
    const parsed = new URL(zipUrl);
    return (
      parsed.hostname === "github.com" ||
      parsed.hostname === "codeload.github.com"
    );
  } catch {
    return false;
  }
}

export const __testables = {
  detectPluginTypeAndName,
  findCommonPrefix,
  parseGitHubUrl,
  resolveAddonProxyUrl,
  resolvePluginZipDownloadUrl,
  shouldProxyZipUrl,
};
