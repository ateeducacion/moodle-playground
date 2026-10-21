// Stand-in for the @php-wasm/web + @php-wasm/universal boundary (and the
// IndexedDB-backed fs-persistence module) used by php-loader.js, so its
// runtime factories can run under Node without loading a WASM binary.
// Installed through module.registerHooks() in the tests that need it; the
// tests read and steer `state`.
import { __private__dont__use, setPhpIniEntries } from "@php-wasm/universal";

export { __private__dont__use, setPhpIniEntries };

export const state = {
  instances: [],
  loadCalls: [],
  certificates: 0,
  clearedJournals: [],
  persistence: [],
  mkdirTreeThrows: false,
  flushResult: { ok: true, flushedOps: 3 },
};

export async function generateCertificate(options) {
  state.certificates += 1;
  return { certificate: { cn: options.subject.commonName } };
}

export function certificateToPEM(certificate) {
  return `PEM(${certificate.cn})`;
}

export async function loadWebRuntime(version, options) {
  state.loadCalls.push({ version, options });
  return state.loadCalls.length;
}

export class PHP {
  constructor(runtimeId) {
    this.runtimeId = runtimeId;
    this.files = new Map();
    this.dirs = [];
    this.sapiName = null;
    this.runs = [];
    this[__private__dont__use] = {
      FS: {
        mkdirTree: (path) => {
          if (state.mkdirTreeThrows) throw new Error(`EEXIST ${path}`);
          this.dirs.push(path);
        },
      },
    };
    state.instances.push(this);
  }

  async setSapiName(name) {
    this.sapiName = name;
  }

  writeFile(path, data) {
    this.files.set(path, data);
  }

  readFileAsText(path) {
    return String(this.files.get(path) ?? "");
  }

  fileExists(path) {
    return this.files.has(path);
  }

  isDir() {
    return false;
  }

  async run(request) {
    this.runs.push(request);
    return { text: "ran", errors: "" };
  }
}

export async function clearJournal(scopeId) {
  state.clearedJournals.push(scopeId);
}

export async function initFsPersistence(php, scopeId) {
  state.persistence.push({ php, scopeId });
  return { flushNow: async (options) => ({ ...state.flushResult, options }) };
}
