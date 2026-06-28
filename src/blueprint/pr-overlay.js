/**
 * Pure helpers for the `applyPrOverlay` blueprint step.
 *
 * These functions are intentionally synchronous and side-effect free so they
 * can be unit tested without a PHP runtime or the network. The step handler in
 * steps/pr-overlay.js wires them to php.run()/php.writeFile() and fetch().
 *
 * The overlay applies the *final* contents of a pull request's changed files on
 * top of a prebuilt Moodle base in the browser filesystem (whole-file
 * replacement, never a unified diff). See
 * docs/decisions/0016-runtime-pr-file-overlay.md for the rationale.
 */

// Default safety caps. Both can be overridden per step via maxFiles /
// maxFileBytes. They guard against a runaway PR (thousands of files) or a
// single huge blob exhausting the WASM heap.
export const DEFAULT_MAX_OVERLAY_FILES = 200;
export const DEFAULT_MAX_OVERLAY_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB

// GitHub PR file paths are relative to the repository root. Moodle Playground's
// Moodle repository root is /www/moodle. For Moodle 5.1+ the web docroot is
// /www/moodle/public, but PR paths already carry the `public/` prefix, so the
// overlay root stays /www/moodle and is NOT auto-prefixed.
export const DEFAULT_OVERLAY_ROOT = "/www/moodle";

// GitHub change statuses mapped to the canonical operations the overlay
// performs. "changed" and "copied" are GitHub variants we fold into the
// closest write operation. Anything else is rejected so a misleading preview is
// never silently produced.
const STATUS_MAP = {
  added: "added",
  modified: "modified",
  changed: "modified",
  copied: "added",
  removed: "removed",
  deleted: "removed",
  renamed: "renamed",
};

// Paths (relative to the repo root) whose change indicates a Moodle upgrade is
// likely required: the core version file, the public-docroot version file, and
// any plugin/subsystem db/{install.xml,install.php,upgrade.php}. Kept identical
// to the action's classifier so both sides agree on `runUpgrade: auto`.
const UPGRADE_TRIGGER_RE =
  /^(?:(?:public\/)?version\.php|(?:.*\/)?db\/(?:install\.xml|install\.php|upgrade\.php))$/u;

/**
 * Validate a single repo-relative overlay path. Throws on anything unsafe.
 * Returns the path unchanged on success.
 *
 * @param {unknown} relPath
 * @returns {string}
 */
export function validateOverlayPath(relPath) {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new Error("applyPrOverlay: file path must be a non-empty string.");
  }
  if (relPath.includes("\0")) {
    throw new Error("applyPrOverlay: file path must not contain a null byte.");
  }
  // Reject other control characters (anything below U+0020).
  for (let i = 0; i < relPath.length; i++) {
    if (relPath.charCodeAt(i) < 0x20) {
      throw new Error(
        "applyPrOverlay: file path must not contain control characters.",
      );
    }
  }
  if (relPath.includes("\\")) {
    throw new Error(
      `applyPrOverlay: file path must use '/' separators, not backslashes: ${relPath}`,
    );
  }
  if (relPath.startsWith("/")) {
    throw new Error(
      `applyPrOverlay: file path must be relative, not absolute: ${relPath}`,
    );
  }
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new Error(
        `applyPrOverlay: file path has an unsafe segment ('${seg}'): ${relPath}`,
      );
    }
  }
  return relPath;
}

/**
 * Join a validated repo-relative path onto the overlay root. Defense in depth:
 * re-checks containment so a write can never escape the root.
 *
 * @param {string} root absolute root (e.g. "/www/moodle")
 * @param {string} relPath repo-relative path
 * @returns {string} absolute path inside the root
 */
export function joinRoot(root, relPath) {
  const safe = validateOverlayPath(relPath);
  const base = String(root).replace(/\/+$/u, "");
  const full = `${base}/${safe}`;
  if (!full.startsWith(`${base}/`)) {
    throw new Error(`applyPrOverlay: refusing to write outside root: ${full}`);
  }
  return full;
}

/**
 * Normalize a raw GitHub change status to a canonical operation.
 *
 * @param {unknown} status
 * @returns {"added"|"modified"|"removed"|"renamed"}
 */
export function normalizeStatus(status) {
  const mapped = STATUS_MAP[String(status || "").toLowerCase()];
  if (!mapped) {
    throw new Error(
      `applyPrOverlay: unsupported file status '${status}'. ` +
        "Expected one of: added, modified, changed, removed, renamed, copied.",
    );
  }
  return mapped;
}

/**
 * Normalize an overlay manifest into validated operations. Each entry becomes
 * `{ path, status, rawUrl, previousPath, size }`. Throws on any structural or
 * path-safety problem so a malformed manifest fails loudly instead of producing
 * a misleading preview.
 *
 * @param {unknown} files
 * @returns {Array<{path: string, status: string, rawUrl: string|null, previousPath: string|null, size: number|null}>}
 */
export function normalizeOverlayManifest(files) {
  if (!Array.isArray(files)) {
    throw new Error("applyPrOverlay: 'files' must be an array.");
  }
  return files.map((file, i) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error(`applyPrOverlay: files[${i}] must be an object.`);
    }
    const status = normalizeStatus(file.status);
    validateOverlayPath(file.path);

    const op = {
      path: file.path,
      status,
      rawUrl: typeof file.rawUrl === "string" ? file.rawUrl : null,
      previousPath:
        typeof file.previousPath === "string" ? file.previousPath : null,
      size: typeof file.size === "number" ? file.size : null,
    };

    if (status === "renamed") {
      if (!op.previousPath) {
        throw new Error(
          `applyPrOverlay: files[${i}] is renamed but has no 'previousPath'.`,
        );
      }
      validateOverlayPath(op.previousPath);
    }

    // Added/modified/renamed entries need a rawUrl to fetch the new content;
    // removed entries do not.
    if (status !== "removed" && !op.rawUrl) {
      throw new Error(
        `applyPrOverlay: files[${i}] (${status}) requires a 'rawUrl' to fetch its contents.`,
      );
    }

    return op;
  });
}

/**
 * Decide whether the changed files indicate a Moodle upgrade is likely needed.
 * Accepts either raw manifest entries or normalized operations (objects with a
 * `path`) or bare path strings.
 *
 * @param {Array<string|{path?: string, previousPath?: string}>} files
 * @returns {boolean}
 */
export function overlayNeedsUpgrade(files) {
  const list = Array.isArray(files) ? files : [];
  return list.some((entry) => {
    const candidates =
      typeof entry === "string" ? [entry] : [entry?.path, entry?.previousPath];
    return candidates.some(
      (p) => typeof p === "string" && UPGRADE_TRIGGER_RE.test(p),
    );
  });
}

/**
 * Normalize the runUpgrade option to one of "off" | "on" | "auto".
 * Defaults to "auto" when unset. Throws on an unrecognized value.
 *
 * @param {unknown} value
 * @returns {"off"|"on"|"auto"}
 */
export function normalizeRunUpgrade(value) {
  if (value === undefined || value === null || value === "") {
    return "auto";
  }
  const v = String(value).toLowerCase();
  if (["off", "false", "no", "0"].includes(v)) return "off";
  if (["on", "true", "yes", "1"].includes(v)) return "on";
  if (v === "auto") return "auto";
  throw new Error(
    `applyPrOverlay: invalid runUpgrade '${value}' (expected off, on, or auto).`,
  );
}

/**
 * Build the GitHub REST API URL listing a pull request's changed files.
 *
 * @param {string} repo "owner/name"
 * @param {number|string} pr pull request number
 * @param {{page?: number, perPage?: number}} [opts]
 * @returns {string}
 */
export function buildPrFilesApiUrl(repo, pr, { page = 1, perPage = 100 } = {}) {
  const prNumber = parseInt(pr, 10);
  if (!repo || !/^[^/]+\/[^/]+$/u.test(String(repo))) {
    throw new Error(
      `applyPrOverlay: invalid repo '${repo}' (expected owner/name).`,
    );
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`applyPrOverlay: invalid pr '${pr}'.`);
  }
  return (
    `https://api.github.com/repos/${repo}/pulls/${prNumber}/files` +
    `?per_page=${perPage}&page=${page}`
  );
}

/**
 * Build the GitHub REST API URL for a single pull request (used to resolve the
 * head repo + head SHA before building raw file URLs).
 *
 * @param {string} repo "owner/name"
 * @param {number|string} pr pull request number
 * @returns {string}
 */
export function buildPrApiUrl(repo, pr) {
  const prNumber = parseInt(pr, 10);
  if (!repo || !/^[^/]+\/[^/]+$/u.test(String(repo))) {
    throw new Error(
      `applyPrOverlay: invalid repo '${repo}' (expected owner/name).`,
    );
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`applyPrOverlay: invalid pr '${pr}'.`);
  }
  return `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
}

/**
 * Build a CORS-accessible raw.githubusercontent.com URL for a file at a commit.
 *
 * The GitHub pulls/files API returns `raw_url` as a `github.com/<o>/<r>/raw/...`
 * URL, which is a 302 redirect that browsers CANNOT fetch cross-origin (no CORS
 * headers). raw.githubusercontent.com serves the same content with
 * `access-control-allow-origin: *`, including a PR head commit referenced via
 * either the head (fork) repo or the base repo. Each path segment is URL-encoded
 * while `/` separators are preserved.
 *
 * @param {string} repoFullName "owner/name"
 * @param {string} sha commit SHA
 * @param {string} filename repo-relative path
 * @returns {string}
 */
export function buildRawGithubUrl(repoFullName, sha, filename) {
  const encodedPath = String(filename)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `https://raw.githubusercontent.com/${repoFullName}/${sha}/${encodedPath}`;
}

/**
 * Optionally route a GitHub URL through a CORS/caching proxy. When no proxy is
 * given the URL is returned unchanged (direct GitHub endpoints are the default
 * and work for public repos). The proxy is expected to accept a URL-passthrough
 * `?url=` parameter.
 *
 * @param {string} url
 * @param {string} [proxy] proxy base URL
 * @returns {string}
 */
export function applyProxy(url, proxy) {
  if (!proxy) return url;
  const base = String(proxy).replace(/\/+$/u, "");
  return `${base}/?url=${encodeURIComponent(url)}`;
}
