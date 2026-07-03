/**
 * Pure helpers for the editable Blueprint panel (no DOM access here — see
 * `blueprint-editor.js` for CodeJar wiring). Kept dependency-free so they can
 * be unit tested directly.
 */

/**
 * Escape a string for safe insertion into HTML text content.
 *
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Matches, in priority order: a quoted string (optionally followed by the
// colon that marks it as an object key), a boolean literal, a null literal,
// or a number. Everything else (punctuation, whitespace) falls through
// untouched between matches.
const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gu;

/**
 * Render JSON source as HTML with `bp-tok-*` span classes for keys, strings,
 * numbers, booleans and null — a small hand-rolled tokenizer instead of a
 * full syntax-highlighting dependency.
 *
 * @param {string} code
 * @returns {string} HTML-safe markup.
 */
export function highlightJson(code) {
  const text = typeof code === "string" ? code : "";
  let html = "";
  let lastIndex = 0;

  for (const match of text.matchAll(JSON_TOKEN_RE)) {
    const [
      full,
      stringLiteral,
      colonSuffix,
      boolLiteral,
      nullLiteral,
      numberLiteral,
    ] = match;
    html += escapeHtml(text.slice(lastIndex, match.index));

    if (stringLiteral !== undefined) {
      const cssClass = colonSuffix ? "bp-tok-key" : "bp-tok-string";
      html += `<span class="${cssClass}">${escapeHtml(stringLiteral)}</span>`;
      html += escapeHtml(colonSuffix || "");
    } else if (boolLiteral !== undefined) {
      html += `<span class="bp-tok-boolean">${escapeHtml(boolLiteral)}</span>`;
    } else if (nullLiteral !== undefined) {
      html += `<span class="bp-tok-null">${escapeHtml(nullLiteral)}</span>`;
    } else if (numberLiteral !== undefined) {
      html += `<span class="bp-tok-number">${escapeHtml(numberLiteral)}</span>`;
    }

    lastIndex = match.index + full.length;
  }

  html += escapeHtml(text.slice(lastIndex));
  return html;
}

/**
 * Pretty-print a JSON string with 2-space indentation.
 *
 * @param {string} rawText
 * @returns {string}
 * @throws {SyntaxError} if `rawText` is not valid JSON.
 */
export function formatBlueprintText(rawText) {
  return JSON.stringify(JSON.parse(rawText), null, 2);
}

/**
 * Compute the code to seed the editor with from source text (typically the
 * hidden `#blueprint-textarea` value). Pretty-prints valid JSON; falls back
 * to the raw text unchanged if it can't be parsed, so partially-typed or
 * externally-supplied text is never discarded.
 *
 * @param {*} sourceText
 * @returns {string}
 */
export function getInitialBlueprintCode(sourceText) {
  const text = typeof sourceText === "string" ? sourceText : "";
  if (!text.trim()) {
    return "";
  }
  try {
    return formatBlueprintText(text);
  } catch {
    return text;
  }
}

function describeBlueprintErrors(errors) {
  if (!errors || errors.length === 0) {
    return "Blueprint schema is invalid.";
  }
  if (errors.length === 1) {
    return `Blueprint is invalid: ${errors[0]}`;
  }
  return `Blueprint is invalid (${errors.length} issues): ${errors[0]}`;
}

/**
 * Run the editor content through the JSON parse -> blueprint normalize ->
 * blueprint schema validation pipeline, mapping the result to a single
 * user-facing status. Never throws.
 *
 * @param {string} rawText
 * @param {{parseBlueprint: Function, validateBlueprint: Function}} deps
 * @returns {{valid: boolean, stage: "json"|"schema"|"valid", message: string, errors: string[], blueprint: object|null}}
 */
export function createBlueprintValidationResult(rawText, deps) {
  const { parseBlueprint, validateBlueprint } = deps;

  const trimmed = typeof rawText === "string" ? rawText.trim() : "";
  if (!trimmed) {
    return {
      valid: false,
      stage: "json",
      message: "Blueprint cannot be empty.",
      errors: [],
      blueprint: null,
    };
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch (error) {
    return {
      valid: false,
      stage: "json",
      message: `Invalid JSON: ${error.message}`,
      errors: [],
      blueprint: null,
    };
  }

  let blueprint;
  try {
    blueprint = parseBlueprint(parsedJson);
  } catch (error) {
    return {
      valid: false,
      stage: "json",
      message: `Invalid JSON: ${error.message}`,
      errors: [],
      blueprint: null,
    };
  }

  const { valid, errors } = validateBlueprint(blueprint);
  if (!valid) {
    return {
      valid: false,
      stage: "schema",
      message: describeBlueprintErrors(errors),
      errors,
      blueprint,
    };
  }

  return {
    valid: true,
    stage: "valid",
    message: "Blueprint is valid.",
    errors: [],
    blueprint,
  };
}

/**
 * Base64-encode a blueprint for the `?blueprint=` URL param when
 * `compressBlueprint` (gzip) is unavailable. Mirrors the fallback already
 * used by the Import flow in `src/shell/main.js`.
 *
 * @param {object} blueprint
 * @returns {string}
 */
export function encodeBlueprintFallback(blueprint) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(blueprint))));
}

/**
 * Build the URL to navigate to in order to run an edited blueprint: sets
 * `blueprint=<encodedBlueprint>` and removes any `blueprint-url` param,
 * preserving everything else on the current URL.
 *
 * @param {string} currentHref
 * @param {string} encodedBlueprint
 * @returns {string}
 */
export function buildBlueprintRunUrl(currentHref, encodedBlueprint) {
  const url = new URL(currentHref);
  url.searchParams.set("blueprint", encodedBlueprint);
  url.searchParams.delete("blueprint-url");
  return url.toString();
}
