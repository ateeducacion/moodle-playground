import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Window } from "happy-dom";
import { parseBlueprintParam } from "../../src/blueprint/parser.js";

// The editor loads CodeJar from a CDN with a dynamic import(). Node cannot
// import https: URLs, so resolve that one specifier to a local module whose
// CodeJar delegates to whatever fake the current test installs.
const CODEJAR_URL =
  "https://cdn.jsdelivr.net/npm/codejar@4.3.0/dist/codejar.js";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === CODEJAR_URL) {
      return {
        url: `data:text/javascript,${encodeURIComponent(
          "export const CodeJar = (...args) => globalThis.__fakeCodeJar(...args);",
        )}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { initBlueprintEditor } = await import(
  "../../src/shell/blueprint-editor.js"
);

const VALID = JSON.stringify({ steps: [{ step: "login", username: "admin" }] });

let win;
let clipboard;

function createElements({ mount = true } = {}) {
  win.document.body.innerHTML = `
    <div id="mount" class="is-hidden" contenteditable="true"></div>
    <textarea id="ta" readonly></textarea>
    <p id="status"></p>
    <button id="run" disabled></button>
    <button id="copy" title="Copy blueprint JSON" aria-label="Copy JSON"><svg></svg></button>`;
  const $ = (sel) => win.document.querySelector(sel);
  return {
    mount: mount ? $("#mount") : null,
    textarea: $("#ta"),
    statusEl: $("#status"),
    runButton: $("#run"),
    copyButton: $("#copy"),
  };
}

function createFakeJar() {
  const jar = { code: "", updates: [], listeners: [] };
  globalThis.__fakeCodeJar = (element, highlight, options) => {
    jar.element = element;
    jar.highlight = highlight;
    jar.options = options;
    return {
      toString: () => jar.code,
      updateCode(code, callOnUpdate) {
        // Like CodeJar, render the plain code into the element.
        jar.code = code;
        element.textContent = code;
        jar.updates.push([code, callOnUpdate]);
      },
      onUpdate(fn) {
        jar.listeners.push(fn);
      },
    };
  };
  jar.type = (code) => {
    jar.code = code;
    for (const fn of jar.listeners) fn(code);
  };
  return jar;
}

// The deadline is wall-clock time, not a count of event-loop turns: gzip runs
// on the libuv threadpool, so on a busy machine encoding outlasts any fixed
// number of turns.
async function waitFor(predicate, message = "condition not met") {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  win = new Window({ url: "https://play.example/moodle/?blueprint-url=x" });
  clipboard = { written: [], fail: false };
  globalThis.window = win;
  globalThis.document = win.document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text) => {
          if (clipboard.fail) throw new Error("denied");
          clipboard.written.push(text);
        },
      },
    },
  });
});

afterEach(async () => {
  delete globalThis.__fakeCodeJar;
  await win.happyDOM.close();
});

describe("initBlueprintEditor with the textarea fallback", () => {
  it("validates the seeded text and makes the textarea editable", () => {
    const els = createElements({ mount: false });
    els.textarea.value = VALID;
    const editor = initBlueprintEditor(els);

    assert.equal(els.textarea.readOnly, false);
    assert.equal(editor.getCode(), VALID);
    assert.equal(editor.getValidationResult().valid, true);
    assert.ok(els.statusEl.classList.contains("is-valid"));
    assert.equal(els.runButton.disabled, false);
  });

  it("revalidates on input and disables Run for invalid JSON", () => {
    const els = createElements({ mount: false });
    initBlueprintEditor(els);
    assert.equal(els.statusEl.textContent, "Blueprint cannot be empty.");
    assert.equal(els.runButton.disabled, true);

    els.textarea.value = "{ nope";
    els.textarea.dispatchEvent(new win.Event("input"));
    assert.ok(els.statusEl.classList.contains("is-invalid"));
    assert.match(els.statusEl.textContent, /^Invalid JSON/);

    els.textarea.value = VALID;
    els.textarea.dispatchEvent(new win.Event("input"));
    assert.ok(els.statusEl.classList.contains("is-valid"));
    assert.equal(els.runButton.disabled, false);
  });

  it("keeps Run disabled while locked even for a valid blueprint", () => {
    const els = createElements({ mount: false });
    const editor = initBlueprintEditor(els);
    editor.setCode(VALID);
    editor.setLocked(true);
    assert.equal(els.runButton.disabled, true);
    editor.setLocked(false);
    assert.equal(els.runButton.disabled, false);
  });

  it("setCode syncs the textarea and treats non-strings as empty", () => {
    const els = createElements({ mount: false });
    const editor = initBlueprintEditor(els);
    editor.setCode(VALID);
    assert.equal(els.textarea.value, VALID);
    editor.setCode(42);
    assert.equal(editor.getCode(), "");
    assert.equal(editor.getValidationResult().valid, false);
  });

  it("Run encodes the blueprint into the URL and drops blueprint-url", async () => {
    const els = createElements({ mount: false });
    const location = { href: "https://play.example/moodle/?blueprint-url=x" };
    const editor = initBlueprintEditor(els, { location });
    editor.setCode(VALID);

    els.runButton.click();
    assert.equal(els.runButton.disabled, true);
    assert.ok(els.statusEl.classList.contains("is-running"));
    await waitFor(() => location.href.includes("blueprint="));

    const url = new URL(location.href);
    assert.equal(url.searchParams.has("blueprint-url"), false);
    assert.deepEqual(
      await parseBlueprintParam(url.searchParams.get("blueprint")),
      JSON.parse(VALID),
    );
  });

  it("Run does nothing for an invalid blueprint", async () => {
    const els = createElements({ mount: false });
    const location = { href: "https://play.example/" };
    const editor = initBlueprintEditor(els, { location });
    editor.setCode("[");
    els.runButton.disabled = false;
    els.runButton.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(location.href, "https://play.example/");
    assert.ok(els.statusEl.classList.contains("is-invalid"));
  });

  it("Copy writes the JSON and shows a checkmark, then restores the button", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const els = createElements({ mount: false });
    const editor = initBlueprintEditor(els);
    editor.setCode(VALID);
    const originalHtml = els.copyButton.innerHTML;

    els.copyButton.click();
    await waitFor(() => clipboard.written.length === 1);
    assert.equal(clipboard.written[0], VALID);
    await waitFor(() => els.copyButton.getAttribute("title") === "Copied!");
    assert.equal(els.copyButton.getAttribute("aria-label"), "Copied!");

    t.mock.timers.tick(1200);
    assert.equal(els.copyButton.innerHTML, originalHtml);
    assert.equal(els.copyButton.getAttribute("title"), "Copy blueprint JSON");
    assert.equal(els.copyButton.getAttribute("aria-label"), "Copy JSON");
  });

  it("Copy leaves the button untouched when the clipboard rejects", async () => {
    clipboard.fail = true;
    const els = createElements({ mount: false });
    initBlueprintEditor(els);
    els.copyButton.click();
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(els.copyButton.getAttribute("title"), "Copy blueprint JSON");
  });

  it("works without optional elements", () => {
    const editor = initBlueprintEditor({ textarea: null }, {});
    editor.setCode(VALID);
    editor.setLocked(true);
    assert.equal(editor.getCode(), VALID);
    assert.equal(editor.getValidationResult().valid, true);
  });
});

describe("initBlueprintEditor with CodeJar", () => {
  it("hands editing over to CodeJar and highlights the mount", async () => {
    const jar = createFakeJar();
    const els = createElements();
    els.textarea.value = VALID;
    els.textarea.focus();
    const editor = initBlueprintEditor(els);

    await waitFor(() => !els.mount.classList.contains("is-hidden"));
    assert.ok(els.textarea.classList.contains("is-hidden"));
    assert.equal(jar.element, els.mount);
    assert.deepEqual(jar.options, { tab: "  " });
    assert.deepEqual(jar.updates[0], [VALID, false]);
    assert.match(els.mount.innerHTML, /<span/);
    assert.equal(win.document.activeElement, els.mount);

    // Typing in CodeJar keeps the hidden textarea in sync.
    jar.type("{");
    assert.equal(els.textarea.value, "{");
    assert.equal(editor.getCode(), "{");
    assert.ok(els.statusEl.classList.contains("is-invalid"));

    // The fallback textarea's input listener is inert once CodeJar owns editing.
    els.textarea.value = VALID;
    els.textarea.dispatchEvent(new win.Event("input"));
    assert.equal(editor.getValidationResult().valid, false);

    editor.setCode(VALID);
    assert.deepEqual(jar.updates.at(-1), [VALID, false]);
    assert.equal(editor.getValidationResult().valid, true);
  });

  it("does not steal focus when the textarea was not focused", async () => {
    createFakeJar();
    const els = createElements();
    initBlueprintEditor(els);
    await waitFor(() => !els.mount.classList.contains("is-hidden"));
    assert.notEqual(win.document.activeElement, els.mount);
  });

  it("keeps the textarea editor when CodeJar fails to start", async () => {
    globalThis.__fakeCodeJar = () => {
      throw new Error("CDN module broken");
    };
    const els = createElements();
    const editor = initBlueprintEditor(els);
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(els.mount.classList.contains("is-hidden"));
    els.textarea.value = VALID;
    els.textarea.dispatchEvent(new win.Event("input"));
    assert.equal(editor.getCode(), VALID);
  });
});
