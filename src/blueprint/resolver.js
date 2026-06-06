import { parseBlueprint } from "./parser.js";
import { validateBlueprint } from "./schema.js";
import { saveBlueprint } from "./storage.js";

/**
 * Resolve the active blueprint from multiple sources in priority order.
 *
 * Precedence:
 *   1. ?blueprint= query param (inline JSON / base64 / data-URL)
 *   2. ?blueprint-url= query param (remote URL)
 *   3. sessionStorage
 *   4. defaultBlueprintUrl (fetch)
 *   5. Built-in minimal default
 *
 * @param {{ scopeId: string, location?: Location, defaultBlueprintUrl?: string }} options
 * @returns {Promise<object>} Resolved blueprint object.
 */
export async function resolveBlueprint({
  scopeId,
  location,
  defaultBlueprintUrl,
} = {}) {
  const loc =
    location || (typeof window !== "undefined" ? window.location : null);

  // Context constants derived from the URL (repo/ref of the branch this preview
  // is for). Merged over the blueprint's own `constants` so a committed
  // blueprint can use {{REPO}}/{{REF}} placeholders that resolve to the PR
  // branch, instead of hard-coding `main`. See deriveContextConstants().
  const blueprintUrlParam = loc
    ? new URL(loc.href).searchParams.get("blueprint-url")
    : null;
  const contextConstants = deriveContextConstants(loc, blueprintUrlParam);

  const finalize = (blueprint) => {
    const merged =
      contextConstants && Object.keys(contextConstants).length
        ? {
            ...blueprint,
            constants: { ...(blueprint.constants || {}), ...contextConstants },
          }
        : blueprint;
    saveBlueprint(scopeId, merged);
    return merged;
  };

  if (loc) {
    const url = new URL(loc.href);

    // 1. ?blueprint= (inline)
    const blueprintParam = url.searchParams.get("blueprint");
    if (blueprintParam) {
      try {
        const blueprint = parseBlueprint(blueprintParam);
        console.log("[blueprint] Resolved from ?blueprint= param (inline).");
        return finalize(blueprint);
      } catch (error) {
        console.warn(
          "[blueprint] Failed to parse ?blueprint= param:",
          error.message,
        );
      }
    }

    // 2. ?blueprint-url= (remote)
    if (blueprintUrlParam) {
      try {
        const response = await fetch(new URL(blueprintUrlParam, loc.href), {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const blueprint = await response.json();
        const validation = validateBlueprint(blueprint);
        if (!validation.valid) {
          throw new Error(`Invalid blueprint: ${validation.errors.join(", ")}`);
        }
        console.log("[blueprint] Resolved from ?blueprint-url= param.");
        return finalize(blueprint);
      } catch (error) {
        console.warn(
          "[blueprint] Failed to fetch ?blueprint-url=:",
          error.message,
        );
      }
    }
  }

  // 3. sessionStorage blueprints are not reloaded on bare URL navigations —
  //    the ephemeral runtime should boot clean. Blueprints from ?blueprint=
  //    params are returned above before reaching this point.

  // 4. defaultBlueprintUrl
  if (defaultBlueprintUrl) {
    try {
      const base = loc ? loc.href : undefined;
      const response = await fetch(new URL(defaultBlueprintUrl, base), {
        cache: "no-store",
      });
      if (response.ok) {
        const blueprint = await response.json();
        const validation = validateBlueprint(blueprint);
        if (!validation.valid) {
          console.warn(
            "[blueprint] Default blueprint invalid:",
            validation.errors,
          );
        }
        console.log("[blueprint] Resolved from defaultBlueprintUrl.");
        return finalize(blueprint);
      }
    } catch (error) {
      console.warn(
        "[blueprint] Failed to fetch default blueprint URL:",
        error.message,
      );
    }
  }

  // 5. Built-in minimal default
  console.log("[blueprint] Using built-in default.");
  return finalize(buildMinimalDefault());
}

/**
 * Derive `{{REPO}}` / `{{REF}}` / `{{OWNER}}` constants from the request URL so
 * a committed blueprint can install the plugin from the branch it is being
 * previewed for, without hard-coding `main`.
 *
 * Sources, lowest to highest precedence:
 *   1. The `?blueprint-url=` value's own query (`repo`, `branch`/`ref`/
 *      `commit`/`release`) — e.g. the github-proxy `?repo=o/r&branch=feat/x&path=blueprint.json`
 *      form. Slash-safe because the ref is a query param.
 *   2. The `?blueprint-url=` value's path when it is a raw.githubusercontent.com
 *      URL (`/{owner}/{repo}/{ref}/...`). Best-effort; assumes a single-segment ref.
 *   3. Explicit `?repo=` / `?ref=` (or `?owner=` / `?branch=`) on the playground URL.
 *
 * @param {Location|URL|null} loc
 * @param {string|null} blueprintUrlParam
 * @returns {Record<string, string>}
 */
function deriveContextConstants(loc, blueprintUrlParam) {
  const out = {};

  const setRepo = (repo) => {
    if (typeof repo !== "string" || !repo.includes("/")) return;
    const [owner, ...rest] = repo.split("/");
    if (!owner || rest.length === 0 || !rest[0]) return;
    out.REPO = `${owner}/${rest.join("/")}`;
    out.OWNER = owner;
  };
  const setRef = (ref) => {
    if (typeof ref === "string" && ref) {
      out.REF = ref;
      out.BRANCH = ref;
    }
  };

  // 1 & 2. From the ?blueprint-url= value itself.
  if (blueprintUrlParam) {
    try {
      const bu = new URL(blueprintUrlParam, loc?.href ? loc.href : undefined);
      setRepo(bu.searchParams.get("repo"));
      setRef(
        bu.searchParams.get("branch") ||
          bu.searchParams.get("ref") ||
          bu.searchParams.get("commit") ||
          bu.searchParams.get("release"),
      );
      if (!out.REPO && bu.hostname === "raw.githubusercontent.com") {
        // raw URLs come in two shapes:
        //   /{owner}/{repo}/{ref}/{path}
        //   /{owner}/{repo}/refs/heads|tags/{ref}/{path}  (explicit form)
        const seg = bu.pathname.split("/").filter(Boolean);
        if (seg.length >= 3) {
          setRepo(`${seg[0]}/${seg[1]}`);
          if (
            seg[2] === "refs" &&
            (seg[3] === "heads" || seg[3] === "tags") &&
            seg.length >= 5
          ) {
            setRef(seg[4]);
          } else {
            setRef(seg[2]);
          }
        }
      }
    } catch {
      // Ignore an unparseable blueprint-url; explicit params may still apply.
    }
  }

  // 3. Explicit overrides on the playground URL.
  if (loc?.href) {
    try {
      const u = new URL(loc.href);
      const repo = u.searchParams.get("repo");
      const owner = u.searchParams.get("owner");
      const ref = u.searchParams.get("ref") || u.searchParams.get("branch");
      if (repo) setRepo(repo);
      if (owner) out.OWNER = owner;
      if (ref) setRef(ref);
    } catch {
      // Ignore.
    }
  }

  return out;
}

function buildMinimalDefault() {
  return {
    landingPage: "/",
    preferredVersions: { php: "8.3", moodle: "5.0" },
    constants: {
      ADMIN_USER: "admin",
      ADMIN_PASS: "password",
      ADMIN_EMAIL: "admin@example.com",
    },
    steps: [
      {
        step: "installMoodle",
        options: {
          adminUser: "admin",
          adminPass: "password",
          adminEmail: "admin@example.com",
          siteName: "Moodle Playground",
          locale: "en",
          timezone: "UTC",
        },
      },
      { step: "login", username: "admin" },
      { step: "setLandingPage", path: "/my/" },
    ],
  };
}
