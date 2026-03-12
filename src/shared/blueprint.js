import { SNAPSHOT_VERSION } from "./protocol.js";

const BLUEPRINT_KEY_PREFIX = "moodle-playground:blueprint";

function hasWindow() {
  return typeof window !== "undefined";
}

function normalizePath(path, fallback = "/") {
  if (!path || typeof path !== "string") {
    return fallback;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function getBlueprintStorageKey(scopeId) {
  return `${BLUEPRINT_KEY_PREFIX}:${scopeId}`;
}

function absolutizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  if (!hasWindow()) {
    return text;
  }

  try {
    return new URL(text, window.location.href).toString();
  } catch {
    return text;
  }
}

export function getBlueprintSchemaUrl() {
  return new URL("../../assets/blueprints/blueprint-schema.json", import.meta.url).toString();
}

export function buildDefaultBlueprint(config) {
  return {
    $schema: getBlueprintSchemaUrl(),
    meta: {
      title: `${config.siteTitle} Blueprint`,
      author: "moodle-playground",
      description: "Default Moodle Playground blueprint.",
    },
    preferredVersions: {
      php: config.runtimes?.find((runtime) => runtime.default)?.phpVersionLabel || "8.3",
      moodle: "5.0.x",
    },
    landingPage: config.landingPath || "/install.php?lang=en",
    siteOptions: {
      fullname: config.siteTitle,
      shortname: "Playground",
      locale: config.locale,
      timezone: config.timezone,
    },
    login: {
      username: config.admin.username,
      email: config.admin.email,
      password: config.admin.password,
    },
    users: [
      {
        username: config.admin.username,
        email: config.admin.email,
        password: config.admin.password,
        role: "manager",
      },
    ],
    categories: [
      {
        name: "Playground Courses",
      },
    ],
    courses: [
      {
        fullname: "Getting Started",
        shortname: "PLAY101",
        category: "Playground Courses",
        summary: "Default course created from the Moodle Playground blueprint.",
      },
    ],
  };
}

export function normalizeBlueprint(input, config) {
  const blueprint = (input && typeof input === "object" && !Array.isArray(input))
    ? structuredClone(input)
    : {};
  const fallback = buildDefaultBlueprint(config);
  const users = Array.isArray(blueprint.users) && blueprint.users.length > 0
    ? blueprint.users
    : fallback.users;

  const normalizedUsers = users.map((user, index) => {
    const fallbackUser = index === 0 ? fallback.users[0] : fallback.users[0];
    const username = String(user?.username || fallbackUser.username || `teacher${index + 1}`).trim();
    const email = String(user?.email || fallbackUser.email || `${username}@example.com`).trim();
    const password = String(user?.password || fallbackUser.password || "").trim();

    if (!username || !email || !password) {
      throw new Error(`Blueprint user at index ${index} must include username, email, and password.`);
    }

    return {
      username,
      email,
      password,
      role: String(user?.role || (index === 0 ? "manager" : "teacher")).trim().toLowerCase(),
    };
  });

  return {
    $schema: typeof blueprint.$schema === "string" ? blueprint.$schema : fallback.$schema,
    meta: {
      title: blueprint.meta?.title || fallback.meta.title,
      author: blueprint.meta?.author || fallback.meta.author,
      description: blueprint.meta?.description || fallback.meta.description,
    },
    preferredVersions: {
      php: blueprint.preferredVersions?.php || fallback.preferredVersions.php,
      moodle: blueprint.preferredVersions?.moodle || fallback.preferredVersions.moodle,
    },
    landingPage: normalizePath(blueprint.landingPage || blueprint.landingPath || fallback.landingPage, fallback.landingPage),
    siteOptions: {
      fullname: String(blueprint.siteOptions?.fullname || fallback.siteOptions.fullname).trim(),
      shortname: String(blueprint.siteOptions?.shortname || fallback.siteOptions.shortname).trim(),
      locale: String(blueprint.siteOptions?.locale || fallback.siteOptions.locale).trim(),
      timezone: String(blueprint.siteOptions?.timezone || fallback.siteOptions.timezone).trim(),
    },
    login: {
      username: String(blueprint.login?.username || normalizedUsers[0].username).trim(),
      email: String(blueprint.login?.email || normalizedUsers[0].email).trim(),
      password: String(blueprint.login?.password || normalizedUsers[0].password).trim(),
    },
    users: normalizedUsers,
    categories: Array.isArray(blueprint.categories)
      ? blueprint.categories
        .map((category) => ({ name: String(category?.name || "").trim() }))
        .filter((category) => category.name)
      : fallback.categories,
    courses: Array.isArray(blueprint.courses)
      ? blueprint.courses
        .map((course) => ({
          fullname: String(course?.fullname || "").trim(),
          shortname: String(course?.shortname || "").trim(),
          category: String(course?.category || "").trim(),
          summary: typeof course?.summary === "string" ? course.summary : "",
          image: absolutizeUrl(course?.image || ""),
        }))
        .filter((course) => course.fullname && course.shortname)
      : fallback.courses,
  };
}

export function buildEffectivePlaygroundConfig(config, blueprint) {
  const normalized = normalizeBlueprint(blueprint, config);
  const primaryUser = normalized.users[0];

  return {
    ...config,
    siteTitle: normalized.siteOptions.fullname,
    locale: normalized.siteOptions.locale,
    timezone: normalized.siteOptions.timezone,
    landingPath: normalized.landingPage,
    admin: {
      username: normalized.login.username || primaryUser.username,
      email: normalized.login.email || primaryUser.email,
      password: normalized.login.password || primaryUser.password,
    },
  };
}

export function exportBlueprintPayload(config, blueprint) {
  return normalizeBlueprint(blueprint, config);
}

export function saveActiveBlueprint(scopeId, blueprint) {
  if (!hasWindow()) {
    return;
  }

  window.sessionStorage.setItem(getBlueprintStorageKey(scopeId), JSON.stringify(blueprint));
}

export function loadActiveBlueprint(scopeId) {
  if (!hasWindow()) {
    return null;
  }

  const raw = window.sessionStorage.getItem(getBlueprintStorageKey(scopeId));
  return raw ? JSON.parse(raw) : null;
}

export function clearActiveBlueprint(scopeId) {
  if (!hasWindow()) {
    return;
  }

  window.sessionStorage.removeItem(getBlueprintStorageKey(scopeId));
}

export async function resolveBlueprintForShell(scopeId, config) {
  if (!hasWindow()) {
    return buildDefaultBlueprint(config);
  }

  const stored = loadActiveBlueprint(scopeId);
  if (stored) {
    return normalizeBlueprint(stored, config);
  }

  const url = new URL(window.location.href);
  const blueprintParam = url.searchParams.get("blueprint");
  if (blueprintParam) {
    const response = await fetch(new URL(blueprintParam, window.location.href), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Unable to load blueprint from ${blueprintParam}: ${response.status}`);
    }
    const payload = normalizeBlueprint(await response.json(), config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  if (config.defaultBlueprintUrl) {
    const response = await fetch(new URL(config.defaultBlueprintUrl, window.location.href), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Unable to load default blueprint: ${response.status}`);
    }
    const payload = normalizeBlueprint(await response.json(), config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  const payload = buildDefaultBlueprint(config);
  saveActiveBlueprint(scopeId, payload);
  return payload;
}

export function parseImportedBlueprintPayload(rawPayload, config) {
  if (rawPayload?.version === SNAPSHOT_VERSION) {
    return {
      type: "snapshot",
      runtimeId: rawPayload.runtimeId,
      path: normalizePath(rawPayload.path, config.landingPath || "/"),
    };
  }

  return {
    type: "blueprint",
    blueprint: normalizeBlueprint(rawPayload, config),
  };
}
