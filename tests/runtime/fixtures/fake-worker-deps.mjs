// Stand-in for php-worker.js's runtime boundary (php-loader.js + bootstrap.js),
// installed with module.registerHooks() by the php-worker tests. Each created
// runtime is a scriptable fake php-compat wrapper; tests steer `state`.
export const state = {
  runtimes: [],
  provisioning: [],
  bootstrapCalls: [],
  archiveCalls: [],
  cacheResets: 0,
  bootstrapError: null,
  // One-shot: the next php.refresh() (before bootstrapMoodle()) throws it.
  refreshError: null,
  cacheResetError: null,
  phpinfoError: null,
  manifest: {
    snapshot: {
      url: "https://assets.test/install.sq3",
      localcache: { url: "https://assets.test/localcache.zip" },
    },
  },
  readyPath: "/my/",
  timings: { downloadWaitMs: 7 },
  // (runtime, request) => Response | throws. Default: 200 "ok".
  handler: null,
  staticHit: null,
  errorLog: "",
  rawFiles: new Map(),
  runResult: { text: '{"ok":true}', errors: "" },
  flushResult: { ok: true },
};

function createRawPhp() {
  const files = state.rawFiles;
  return {
    written: [],
    readFileAsBuffer(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path);
    },
    writeFile(path, data) {
      this.written.push(path);
      files.set(path, data);
    },
    mkdirTree() {},
    fileExists: (path) =>
      [...files.keys()].some((p) => p === path || p.startsWith(`${path}/`)),
    isDir: (path) => [...files.keys()].some((p) => p.startsWith(`${path}/`)),
    listFiles: (dir) =>
      [...files.keys()]
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => `${dir}/${p.slice(dir.length + 1).split("/")[0]}`)
        .filter((p, i, all) => all.indexOf(p) === i),
  };
}

export function createPhpRuntime(runtimeConfig, options) {
  const runtime = {
    runtimeConfig,
    options,
    requests: [],
    runs: [],
    writes: [],
    _php: createRawPhp(),
    async refresh() {
      const error = state.refreshError;
      state.refreshError = null;
      if (error) throw error;
      runtime.refreshed = true;
    },
    async request(request) {
      runtime.requests.push(request);
      if (state.handler) return state.handler(runtime, request);
      return new Response("ok", { status: 200 });
    },
    async run(code) {
      runtime.runs.push(code);
      if (typeof state.runResult === "function") return state.runResult(code);
      return state.runResult;
    },
    async writeFile(path, data) {
      runtime.writes.push([path, new TextDecoder().decode(data)]);
    },
    async readFile() {
      if (state.errorLog instanceof Error) throw state.errorLog;
      return state.errorLog;
    },
    serveStaticSync(path) {
      if (typeof state.staticHit === "function") return state.staticHit(path);
      return state.staticHit;
    },
    async flushPersistence(options) {
      if (state.flushResult instanceof Error) throw state.flushResult;
      return { enabled: true, ...state.flushResult, options };
    },
  };
  state.runtimes.push(runtime);
  return runtime;
}

export function createProvisioningRuntime(runtimeConfig, options) {
  const runtime = {
    runtimeConfig,
    options,
    async refresh() {
      if (state.phpinfoError) throw state.phpinfoError;
    },
    async run() {
      return { text: "<h1>phpinfo</h1>", errors: "warning: x" };
    },
  };
  state.provisioning.push(runtime);
  return runtime;
}

export async function startArchiveResolution(options) {
  state.archiveCalls.push(options);
  options.publish("Downloading Moodle bundle.", 0.2);
  return { manifest: state.manifest };
}

export async function bootstrapMoodle(options) {
  state.bootstrapCalls.push(options);
  await options.archivePromise;
  options.publish("Bootstrapping.", 0.5);
  // A lower progress value must not move the bar backwards.
  options.publish("Late download tick.", 0.3);
  if (state.bootstrapError) throw state.bootstrapError;
  return { readyPath: state.readyPath, timings: state.timings };
}

export async function resetRecoveredMoodleCaches() {
  state.cacheResets += 1;
  if (state.cacheResetError) throw state.cacheResetError;
}
