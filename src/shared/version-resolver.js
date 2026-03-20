/**
 * Single source of truth for supported Moodle branches, PHP versions,
 * and compatibility matrix.
 */

export const MOODLE_BRANCHES = [
  {
    branch: "MOODLE_404_STABLE",
    version: "4.4",
    label: "Moodle 4.4",
    gitRef: "MOODLE_404_STABLE",
    webRoot: "/www/moodle",
    manifestFile: "MOODLE_404_STABLE.json",
    bundleDir: "MOODLE_404_STABLE",
    snapshotDir: "MOODLE_404_STABLE/snapshot",
    phpVersions: ["8.1", "8.2", "8.3"],
    default: false,
  },
  {
    branch: "MOODLE_405_STABLE",
    version: "4.5",
    label: "Moodle 4.5 (LTS)",
    gitRef: "MOODLE_405_STABLE",
    webRoot: "/www/moodle",
    manifestFile: "MOODLE_405_STABLE.json",
    bundleDir: "MOODLE_405_STABLE",
    snapshotDir: "MOODLE_405_STABLE/snapshot",
    phpVersions: ["8.1", "8.2", "8.3"],
    default: false,
  },
  {
    branch: "MOODLE_500_STABLE",
    version: "5.0",
    label: "Moodle 5.0",
    gitRef: "MOODLE_500_STABLE",
    webRoot: "/www/moodle",
    manifestFile: "MOODLE_500_STABLE.json",
    bundleDir: "MOODLE_500_STABLE",
    snapshotDir: "MOODLE_500_STABLE/snapshot",
    phpVersions: ["8.2", "8.3", "8.4"],
    default: true,
  },
  {
    branch: "MOODLE_501_STABLE",
    version: "5.1",
    label: "Moodle 5.1",
    gitRef: "MOODLE_501_STABLE",
    webRoot: "/www/moodle/public",
    manifestFile: "MOODLE_501_STABLE.json",
    bundleDir: "MOODLE_501_STABLE",
    snapshotDir: "MOODLE_501_STABLE/snapshot",
    phpVersions: ["8.2", "8.3", "8.4"],
    default: false,
  },
  {
    branch: "main",
    version: "dev",
    label: "Development (main)",
    gitRef: "main",
    webRoot: "/www/moodle/public",
    manifestFile: "main.json",
    bundleDir: "main",
    snapshotDir: "main/snapshot",
    phpVersions: ["8.2", "8.3", "8.4", "8.5"],
    default: false,
  },
];

export const ALL_PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4", "8.5"];
export const DEFAULT_PHP_VERSION = "8.3";
export const DEFAULT_MOODLE_BRANCH = "MOODLE_500_STABLE";

function normalizeStringParam(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

/**
 * Get the metadata object for a given branch name.
 */
export function getBranchMetadata(branch) {
  return MOODLE_BRANCHES.find((entry) => entry.branch === branch) || null;
}

/**
 * Get the default branch metadata.
 */
export function getDefaultBranch() {
  return MOODLE_BRANCHES.find((entry) => entry.default) || MOODLE_BRANCHES[0];
}

/**
 * Return the list of PHP versions compatible with the given branch.
 */
export function getCompatiblePhpVersions(branch) {
  const meta = getBranchMetadata(branch);
  return meta ? meta.phpVersions : [DEFAULT_PHP_VERSION];
}

/**
 * Check whether a PHP version is compatible with a Moodle branch.
 */
export function isCompatibleCombination(phpVersion, branch) {
  const meta = getBranchMetadata(branch);
  if (!meta) {
    return false;
  }
  return meta.phpVersions.includes(phpVersion);
}

/**
 * Resolve a Moodle version string (e.g. "5.0") or branch name to
 * the canonical branch name. Returns null if not found.
 */
export function resolveMoodleBranch(versionOrBranch) {
  if (!versionOrBranch) {
    return null;
  }

  const input = String(versionOrBranch).trim();

  // Direct branch name match
  const byBranch = MOODLE_BRANCHES.find((entry) => entry.branch === input);
  if (byBranch) {
    return byBranch.branch;
  }

  // Version match (e.g. "5.0", "4.4", "dev")
  const byVersion = MOODLE_BRANCHES.find((entry) => entry.version === input);
  if (byVersion) {
    return byVersion.branch;
  }

  // Loose version match: strip trailing ".x" (e.g. "5.0.x" -> "5.0")
  const stripped = input.replace(/\.x$/u, "");
  const byStripped = MOODLE_BRANCHES.find(
    (entry) => entry.version === stripped,
  );
  if (byStripped) {
    return byStripped.branch;
  }

  return null;
}

/**
 * Resolve version selections from URL params, blueprint, or defaults.
 *
 * Precedence: explicit params > blueprint > config defaults.
 *
 * Returns { phpVersion, moodleBranch }.
 */
export function resolveVersions({
  php,
  phpVersion,
  moodle,
  moodleBranch,
  runtimeId,
} = {}) {
  const parsedRuntime = parseRuntimeId(runtimeId);

  // Resolve Moodle branch: explicit branch > version lookup > default
  let resolvedBranch = null;
  if (moodleBranch) {
    resolvedBranch = resolveMoodleBranch(moodleBranch);
  }
  if (!resolvedBranch && moodle) {
    resolvedBranch = resolveMoodleBranch(moodle);
  }
  if (!resolvedBranch && parsedRuntime?.moodleBranch) {
    resolvedBranch = parsedRuntime.moodleBranch;
  }
  if (!resolvedBranch) {
    resolvedBranch = DEFAULT_MOODLE_BRANCH;
  }

  // Resolve PHP version: explicit > compatible default
  let resolvedPhp =
    normalizeStringParam(phpVersion) || normalizeStringParam(php);
  if (!resolvedPhp && parsedRuntime?.phpVersion) {
    resolvedPhp = parsedRuntime.phpVersion;
  }
  if (resolvedPhp && !isCompatibleCombination(resolvedPhp, resolvedBranch)) {
    // Incompatible, fall back
    resolvedPhp = null;
  }
  if (!resolvedPhp) {
    const compatible = getCompatiblePhpVersions(resolvedBranch);
    resolvedPhp = compatible.includes(DEFAULT_PHP_VERSION)
      ? DEFAULT_PHP_VERSION
      : compatible[0];
  }

  return { phpVersion: resolvedPhp, moodleBranch: resolvedBranch };
}

export function resolveRuntimeSelection(options = {}) {
  const resolved = resolveVersions(options);
  return {
    phpVersion: resolved.phpVersion,
    moodleBranch: resolved.moodleBranch,
    runtimeId: buildRuntimeId(resolved.phpVersion, resolved.moodleBranch),
  };
}

export function buildRuntimeLabel(phpVersion, moodleBranch) {
  const meta = getBranchMetadata(moodleBranch);
  return `PHP ${phpVersion} + ${meta?.label || moodleBranch}`;
}

export function resolveRuntimeConfig(config, selection) {
  const baseRuntime =
    config?.runtimes?.find((runtime) => runtime.default) ||
    config?.runtimes?.[0];
  if (!baseRuntime) {
    return null;
  }

  const runtimeId = selection?.runtimeId || baseRuntime.id;
  const resolvedSelection =
    selection?.phpVersion && selection?.moodleBranch
      ? selection
      : resolveRuntimeSelection({ runtimeId });

  const exactRuntime = config.runtimes.find((entry) => entry.id === runtimeId);
  if (exactRuntime) {
    return exactRuntime;
  }

  const equivalentRuntime = config.runtimes.find((entry) => {
    const parsed = parseRuntimeId(entry.id);
    return (
      parsed &&
      parsed.phpVersion === resolvedSelection.phpVersion &&
      parsed.moodleBranch === resolvedSelection.moodleBranch
    );
  });

  return {
    ...(equivalentRuntime || baseRuntime),
    id: resolvedSelection.runtimeId,
    label: buildRuntimeLabel(
      resolvedSelection.phpVersion,
      resolvedSelection.moodleBranch,
    ),
    phpVersionLabel: resolvedSelection.phpVersion,
  };
}

export function shouldTraceRuntimeSelection({ debug, profile } = {}) {
  const normalizedDebug = normalizeStringParam(debug)?.toLowerCase();
  if (
    normalizedDebug &&
    !["0", "false", "off", "no"].includes(normalizedDebug)
  ) {
    return true;
  }

  return String(profile || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry === "runtime" || entry === "runtime-selection");
}

/**
 * Build a runtime ID encoding both PHP version and Moodle branch.
 * e.g., "php83-moodle500" or "php85-main"
 */
export function buildRuntimeId(phpVersion, moodleBranch) {
  const phpPart = `php${String(phpVersion).replace(".", "")}`;
  const meta = getBranchMetadata(moodleBranch);
  let moodlePart;

  if (meta) {
    // Use version for stable branches, "main" for dev
    moodlePart =
      meta.branch === "main"
        ? "main"
        : `moodle${meta.version.replace(".", "")}`;
  } else {
    moodlePart = String(moodleBranch)
      .replace(/[^A-Za-z0-9]/gu, "")
      .toLowerCase();
  }

  return `${phpPart}-${moodlePart}`;
}

/**
 * Parse a runtime ID back to { phpVersion, moodleBranch }.
 * Returns null if the format is not recognized.
 *
 * Handles both new format ("php83-moodle500") and legacy ("php83-cgi").
 */
export function parseRuntimeId(runtimeId) {
  if (!runtimeId || typeof runtimeId !== "string") {
    return null;
  }

  // New format: php83-moodle500, php85-main
  const newMatch = runtimeId.match(/^php(\d)(\d)-(.+)$/u);
  if (newMatch) {
    const phpVersion = `${newMatch[1]}.${newMatch[2]}`;
    const moodlePart = newMatch[3];

    if (moodlePart === "main") {
      return { phpVersion, moodleBranch: "main" };
    }

    // Try to match "moodle500" -> "5.0" -> branch
    const versionMatch = moodlePart.match(/^moodle(\d)(\d+)$/u);
    if (versionMatch) {
      const version = `${versionMatch[1]}.${versionMatch[2]}`;
      const branch = resolveMoodleBranch(version);
      if (branch) {
        return { phpVersion, moodleBranch: branch };
      }
    }

    // Direct branch match
    const branch = resolveMoodleBranch(moodlePart);
    if (branch) {
      return { phpVersion, moodleBranch: branch };
    }
  }

  // Legacy format: php83-cgi -> default branch
  const legacyMatch = runtimeId.match(/^php(\d)(\d)-cgi$/u);
  if (legacyMatch) {
    return {
      phpVersion: `${legacyMatch[1]}.${legacyMatch[2]}`,
      moodleBranch: DEFAULT_MOODLE_BRANCH,
    };
  }

  return null;
}

/**
 * Parse URL query params for version configuration.
 */
export function parseQueryParams(urlOrSearchParams) {
  let params;
  if (urlOrSearchParams instanceof URLSearchParams) {
    params = urlOrSearchParams;
  } else if (typeof urlOrSearchParams === "string") {
    params = new URL(urlOrSearchParams).searchParams;
  } else if (urlOrSearchParams?.searchParams) {
    params = urlOrSearchParams.searchParams;
  } else if (typeof urlOrSearchParams?.search === "string") {
    params = new URLSearchParams(urlOrSearchParams.search);
  } else {
    params = new URLSearchParams();
  }

  return {
    php: params.get("php") || params.get("phpVersion") || null,
    phpVersion: params.get("phpVersion") || null,
    moodle: params.get("moodle") || null,
    moodleBranch: params.get("moodleBranch") || null,
    debug: params.get("debug") || null,
    profile: params.get("profile") || null,
  };
}

/**
 * Build the manifest URL for a given branch.
 */
export function buildManifestUrl(moodleBranch, appBaseUrl) {
  const base =
    appBaseUrl || (typeof __APP_ROOT__ !== "undefined" ? __APP_ROOT__ : "./");
  const meta = getBranchMetadata(moodleBranch);
  const filename = meta ? meta.manifestFile : "latest.json";
  return new URL(`assets/manifests/${filename}`, base).toString();
}
