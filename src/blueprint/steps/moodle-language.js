/**
 * Language pack installation step: installLanguagePack.
 *
 * Installs one or more Moodle language packs via Moodle's own lang_installer
 * (lib/componentlib.class.php) — the engine behind the admin Language packs UI.
 * The download goes to download.moodle.org/langpack, which the github-proxy
 * authorizes, and works in every browser (GET over tcpOverFetch, no streaming
 * request body). See docs/decisions/0006-moodle-langpack-proxy-allowance.md.
 */

import { phpInstallLanguagePacks } from "../php/helpers.js";

// Moodle language codes are lowercase letters/digits/underscores starting with
// a letter (e.g. `es`, `pt_br`, `en_us`). User-supplied codes are interpolated
// into generated PHP, so reject anything else here BEFORE php.run — the same
// injection guard installMoodlePlugin uses for plugin names.
const VALID_LANG_CODE = /^[a-z][a-z0-9_]*$/;

export function registerMoodleLanguageSteps(register) {
  register("installLanguagePack", handleInstallLanguagePack);
}

// Accept `language`/`languages`/`lang` as a single code, a comma-separated
// string, or an array. Returns a de-duplicated list of trimmed codes.
export function normalizeLanguageCodes(step) {
  const raw = step.language ?? step.languages ?? step.lang;
  if (raw === undefined || raw === null) {
    return [];
  }
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const seen = new Set();
  for (const value of list) {
    const code = String(value).trim();
    if (code) {
      seen.add(code);
    }
  }
  return [...seen];
}

async function handleInstallLanguagePack(step, context) {
  const { php, publish } = context;

  const codes = normalizeLanguageCodes(step);
  if (codes.length === 0) {
    throw new Error(
      'installLanguagePack: \'language\' is required (e.g. "es" or ["es", "fr"]).',
    );
  }
  for (const code of codes) {
    if (!VALID_LANG_CODE.test(code)) {
      throw new Error(
        `installLanguagePack: invalid language code '${code}'. ` +
          "Language codes must match /^[a-z][a-z0-9_]*$/.",
      );
    }
  }

  const setDefault = step.setDefault === true;
  if (publish) {
    publish(`Installing language pack(s): ${codes.join(", ")}`, 0.93);
  }

  let result;
  try {
    result = await php.run(phpInstallLanguagePacks(codes, setDefault));
  } catch (err) {
    // A hard network failure inside lang_installer can crash the runtime.
    // Don't fail the whole blueprint — the language is a non-critical add-on.
    if (publish) {
      publish(
        `Language pack install crashed: ${String(err.message || err).slice(0, 200)}`,
        0.94,
      );
    }
    return;
  }

  const text = result?.text || "";
  if (publish) {
    if (text.includes('"ok":true')) {
      publish(`Language pack(s) installed: ${codes.join(", ")}`, 0.94);
    } else {
      publish(
        `Language pack install reported issues: ${text.slice(0, 200)}`,
        0.94,
      );
    }
  }
}

export const __testables = { normalizeLanguageCodes, VALID_LANG_CODE };
