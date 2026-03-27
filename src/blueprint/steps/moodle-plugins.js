/**
 * Plugin installation steps: installMoodlePlugin, installTheme.
 *
 * Downloads plugin files from a GitHub repository (via jsDelivr CDN to avoid
 * CORS restrictions on GitHub ZIP downloads), writes them to the correct
 * Moodle plugin directory, and runs the Moodle upgrade to register the plugin.
 */

const MOODLE_ROOT = "/www/moodle";

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

  const targetDir = resolvePluginDir(pluginType, pluginName);
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

  const targetDir = resolvePluginDir("theme", pluginName);
  await installPluginFiles(step.url, targetDir, context);
  await runMoodleUpgrade("theme", pluginName, targetDir, context);
  context.onPluginInstalled?.(targetDir);
}

function resolvePluginDir(pluginType, pluginName) {
  const typeDir = PLUGIN_TYPE_DIRS[pluginType];
  if (!typeDir) {
    throw new Error(
      `Unknown plugin type '${pluginType}'. Known types: ${Object.keys(PLUGIN_TYPE_DIRS).join(", ")}`,
    );
  }
  return `${MOODLE_ROOT}/${typeDir}/${pluginName}`;
}

/**
 * Install plugin files to the target directory. Tries jsDelivr CDN first
 * (to avoid CORS issues with GitHub ZIP downloads), falls back to direct
 * ZIP download for non-GitHub URLs.
 */
async function installPluginFiles(url, targetDir, context) {
  const githubInfo = parseGitHubUrl(url);
  if (githubInfo) {
    await installViaJsDelivr(githubInfo, targetDir, context);
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

/**
 * Install a plugin by listing files from jsDelivr's API and downloading
 * each file individually from the CDN. This avoids CORS issues with GitHub
 * ZIP downloads.
 */
async function installViaJsDelivr(
  { owner, repo, ref },
  targetDir,
  { php, publish },
) {
  const jsdelivrPkg = `gh/${owner}/${repo}@${ref}`;

  if (publish) {
    publish(
      `Listing plugin files from jsDelivr (${owner}/${repo}@${ref})`,
      0.93,
    );
  }

  // Get file listing from jsDelivr API
  const listUrl = `https://data.jsdelivr.com/v1/packages/${jsdelivrPkg}?structure=flat`;
  const listResponse = await fetch(listUrl);
  if (!listResponse.ok) {
    throw new Error(
      `Failed to list plugin files from jsDelivr: ${listResponse.status} for ${listUrl}`,
    );
  }
  const listing = await listResponse.json();
  const files = listing.files || [];

  if (files.length === 0) {
    throw new Error(`No files found for ${jsdelivrPkg} on jsDelivr.`);
  }

  if (publish) {
    publish(
      `Downloading ${files.length} plugin files from jsDelivr CDN`,
      0.935,
    );
  }

  // Create the target directory directly in MEMFS
  const rawPhp = php._php;
  rawPhp.mkdirTree(targetDir);

  // Download each file from CDN and write directly to MEMFS
  const cdnBase = `https://cdn.jsdelivr.net/${jsdelivrPkg}`;
  let downloaded = 0;

  for (const file of files) {
    const filePath = file.name; // e.g., "/block_participants.php"
    const fullPath = `${targetDir}${filePath}`;

    // Ensure parent directory exists
    const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (parentDir && parentDir !== targetDir) {
      rawPhp.mkdirTree(parentDir);
    }

    const fileUrl = `${cdnBase}${filePath}`;
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      console.warn(
        `[blueprint] Failed to download ${fileUrl}: ${fileResponse.status}`,
      );
      continue;
    }

    const fileBytes = new Uint8Array(await fileResponse.arrayBuffer());
    rawPhp.writeFile(fullPath, fileBytes);
    downloaded++;
  }

  if (publish) {
    publish(
      `Installed ${downloaded}/${files.length} files to ${targetDir}`,
      0.94,
    );
  }
}

/**
 * Fallback: install a plugin by downloading a ZIP directly (for non-GitHub URLs).
 * This may fail due to CORS restrictions if the URL doesn't serve CORS headers.
 */
async function installViaZipDownload(zipUrl, targetDir, { php, publish }) {
  if (publish) publish(`Downloading plugin ZIP from ${zipUrl}`, 0.93);

  const response = await fetch(zipUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download plugin ZIP from ${zipUrl}: ${response.status}`,
    );
  }
  const zipBytes = new Uint8Array(await response.arrayBuffer());

  if (publish) publish(`Extracting plugin to ${targetDir}`, 0.935);

  const { unzipSync } = await import("fflate");
  const entries = unzipSync(zipBytes);

  // GitHub ZIPs have a top-level directory. Find and strip common prefix.
  const paths = Object.keys(entries).filter((p) => !p.endsWith("/"));
  const commonPrefix = findCommonPrefix(paths);

  const rawPhp = php._php;
  rawPhp.mkdirTree(targetDir);

  let fileCount = 0;
  for (const [entryPath, entryData] of Object.entries(entries)) {
    if (entryPath.endsWith("/")) continue;

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
  { php, publish },
) {
  if (publish) publish("Running Moodle upgrade to register plugin.", 0.945);

  const component = `${pluginType}_${pluginName}`;
  const safeDir = targetDir.replaceAll("'", "\\'");

  const code = `<?php
define('CLI_SCRIPT', true);
require('${MOODLE_ROOT}/config.php');
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
