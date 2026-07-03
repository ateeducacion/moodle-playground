import {
  encodeBlueprintParam,
  parseBlueprint,
  validateBlueprint,
} from "../blueprint/index.js";
import {
  buildBlueprintRunUrl,
  createBlueprintValidationResult,
  highlightJson,
} from "./blueprint-editor-core.js";

// Pinned version, loaded on demand so the static shell doesn't need a bundler
// step for it. If the CDN is unreachable the panel falls back to a plain
// editable textarea (see initBlueprintEditor below).
const CODEJAR_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/codejar@4.3.0/dist/codejar.js";

function highlightForCodeJar(editor) {
  editor.innerHTML = highlightJson(editor.textContent);
}

/**
 * Wire the Blueprint panel's editor: CodeJar (with a plain-textarea
 * fallback), live JSON/schema validation, and the Run button. The hidden
 * `textarea` stays in sync with the editor content at all times, so any
 * existing code that reads `#blueprint-textarea` keeps working.
 *
 * @param {{mount: HTMLElement|null, textarea: HTMLTextAreaElement, statusEl: HTMLElement|null, runButton: HTMLButtonElement|null, copyButton: HTMLButtonElement|null}} elements
 * @param {{location?: Location}} [options]
 * @returns {{setCode(text: string): void, getCode(): string, getValidationResult(): object, setLocked(locked: boolean): void}}
 */
export function initBlueprintEditor(elements, options = {}) {
  const { mount, textarea, statusEl, runButton, copyButton } = elements;
  const loc = options.location || window.location;

  let jar = null;
  let locked = false;
  let currentText = textarea ? textarea.value : "";
  let latestResult = createBlueprintValidationResult(currentText, {
    parseBlueprint,
    validateBlueprint,
  });

  function getText() {
    return jar ? jar.toString() : currentText;
  }

  function updateRunButtonState() {
    if (!runButton) return;
    runButton.disabled = locked || !latestResult.valid;
  }

  function applyStatus() {
    if (!statusEl) return;
    statusEl.classList.remove("is-valid", "is-invalid", "is-running");
    statusEl.classList.add(latestResult.valid ? "is-valid" : "is-invalid");
    statusEl.textContent = latestResult.message;
  }

  function revalidate(text) {
    latestResult = createBlueprintValidationResult(text, {
      parseBlueprint,
      validateBlueprint,
    });
    applyStatus();
    updateRunButtonState();
    return latestResult;
  }

  function handleTextChanged(text) {
    currentText = text;
    if (textarea) {
      textarea.value = text;
    }
    revalidate(text);
  }

  if (textarea) {
    textarea.readOnly = false;
    textarea.addEventListener("input", () => {
      if (jar) return; // CodeJar owns editing once it takes over.
      handleTextChanged(textarea.value);
    });
  }

  revalidate(currentText);

  if (mount) {
    import(/* webpackIgnore: true */ CODEJAR_MODULE_URL)
      .then(({ CodeJar }) => {
        // The CDN fetch is async, so the user may already be typing in the
        // fallback textarea by the time this resolves. Carry focus over to
        // the CodeJar mount so those keystrokes keep landing on the active
        // editor instead of silently hitting the now-hidden textarea (whose
        // own input listener turns into a no-op once `jar` is set below).
        const hadFocus = document.activeElement === textarea;

        jar = CodeJar(mount, highlightForCodeJar, { tab: "  " });
        jar.updateCode(currentText, false);
        highlightForCodeJar(mount);
        jar.onUpdate((code) => handleTextChanged(code));

        mount.classList.remove("is-hidden");
        if (textarea) {
          textarea.classList.add("is-hidden");
        }
        if (hadFocus) {
          mount.focus();
        }
      })
      .catch(() => {
        // CodeJar unavailable — the fallback textarea (already wired above)
        // stays the active, visible editor.
      });
  }

  if (runButton) {
    runButton.addEventListener("click", async () => {
      const result = revalidate(getText());
      if (!result.valid) {
        return;
      }

      runButton.disabled = true;
      if (statusEl) {
        statusEl.classList.remove("is-valid", "is-invalid");
        statusEl.classList.add("is-running");
        statusEl.textContent = "Encoding blueprint and restarting playground…";
      }

      const encoded = await encodeBlueprintParam(result.blueprint);
      loc.href = buildBlueprintRunUrl(loc.href, encoded);
    });
  }

  if (copyButton) {
    const originalTitle = copyButton.getAttribute("title") || "";
    const originalAriaLabel = copyButton.getAttribute("aria-label") || "";
    const originalHtml = copyButton.innerHTML;
    const checkmarkHtml =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">' +
      '<path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(getText());
      } catch {
        return;
      }
      copyButton.innerHTML = checkmarkHtml;
      copyButton.setAttribute("title", "Copied!");
      copyButton.setAttribute("aria-label", "Copied!");
      setTimeout(() => {
        copyButton.innerHTML = originalHtml;
        copyButton.setAttribute("title", originalTitle);
        copyButton.setAttribute("aria-label", originalAriaLabel);
      }, 1200);
    });
  }

  return {
    setCode(text) {
      const safeText = typeof text === "string" ? text : "";
      currentText = safeText;
      if (textarea) {
        textarea.value = safeText;
        textarea.scrollTop = 0;
      }
      if (jar) {
        jar.updateCode(safeText, false);
      }
      revalidate(safeText);
    },
    getCode() {
      return getText();
    },
    getValidationResult() {
      return latestResult;
    },
    setLocked(value) {
      locked = Boolean(value);
      updateRunButtonState();
    },
  };
}
