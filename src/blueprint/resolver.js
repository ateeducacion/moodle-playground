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

  if (loc) {
    const url = new URL(loc.href);

    // 1. ?blueprint= (inline)
    const blueprintParam = url.searchParams.get("blueprint");
    if (blueprintParam) {
      try {
        const blueprint = parseBlueprint(blueprintParam);
        console.log("[blueprint] Resolved from ?blueprint= param (inline).");
        saveBlueprint(scopeId, blueprint);
        return blueprint;
      } catch (error) {
        console.warn(
          "[blueprint] Failed to parse ?blueprint= param:",
          error.message,
        );
      }
    }

    // 2. ?blueprint-url= (remote)
    const blueprintUrlParam = url.searchParams.get("blueprint-url");
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
        saveBlueprint(scopeId, blueprint);
        return blueprint;
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
        saveBlueprint(scopeId, blueprint);
        return blueprint;
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
  const fallback = buildMinimalDefault();
  saveBlueprint(scopeId, fallback);
  return fallback;
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
