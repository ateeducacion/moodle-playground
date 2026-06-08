import { phpSetConfigFile, phpSetConfigFiles } from "../php/helpers.js";

export function registerMoodleConfigFileSteps(register) {
  register("setConfigFile", handleSetConfigFile);
  register("setConfigFiles", handleSetConfigFiles);
}

// Monotonic counter keeps temp filenames unique within a session even when two
// steps (or two files) are resolved within the same millisecond.
let fileCounter = 0;

function hasData(value) {
  return value !== undefined && value !== null && value !== "";
}

// The generated scripts install a graceful handler that echoes {"ok":false,...}
// and exit(0) on failure (instead of crashing the WASM runtime), so php.run()
// usually resolves even when the File API call failed. Surface that as a thrown
// error so the executor reports it rather than silently succeeding.
function assertPhpOk(result, label) {
  const text = typeof result?.text === "string" ? result.text : "";
  if (text.includes('"ok":false')) {
    const match = text.match(/"error"\s*:\s*"([^"]*)"/);
    const detail = match ? match[1] : text.slice(0, 200);
    throw new Error(`${label} failed: ${detail}`);
  }
}

// Store a single file in Moodle's File API (system context) and point a config
// value at it. See docs/decisions/0009-file-backed-config-settings-blueprint-steps.md.
async function handleSetConfigFile(step, { php, resources }) {
  if (!step.plugin) throw new Error("setConfigFile: 'plugin' is required.");
  if (!step.name) throw new Error("setConfigFile: 'name' is required.");
  if (!step.filename) throw new Error("setConfigFile: 'filename' is required.");
  if (!hasData(step.data)) {
    throw new Error(
      "setConfigFile: 'data' is required (URL, @reference, or resource descriptor).",
    );
  }

  const bytes = await resources.resolve(step.data);
  const tmpPath = `/tmp/blueprint-configfile-${++fileCounter}-${Date.now()}.bin`;
  await php.writeFile(tmpPath, bytes);

  const code = phpSetConfigFile({
    plugin: step.plugin,
    name: step.name,
    filename: step.filename,
    // filearea defaults to the setting name (the common Moodle convention),
    // unless explicitly overridden.
    filearea: step.filearea || step.name,
    itemid: step.itemid ?? 0,
    filepath: step.filepath || "/",
    replace: step.replace !== false,
    setConfigValue: step.setConfigValue !== false,
    purgeCaches: step.purgeCaches === true,
    author: step.author ?? null,
    license: step.license ?? null,
    source: step.source ?? null,
    userid: step.userid ?? null,
    tmppath: tmpPath,
  });
  const result = await php.run(code);
  assertPhpOk(result, `setConfigFile '${step.name}'`);
}

// Store multiple files in the same File API area and point the config value at
// the first stored file. Top-level fields act as defaults; each file entry may
// override filepath/author/license/source/userid.
async function handleSetConfigFiles(step, { php, resources }) {
  if (!step.plugin) throw new Error("setConfigFiles: 'plugin' is required.");
  if (!step.name) throw new Error("setConfigFiles: 'name' is required.");
  if (!Array.isArray(step.files) || step.files.length === 0) {
    throw new Error("setConfigFiles: 'files' must be a non-empty array.");
  }

  const fileSpecs = [];
  for (let i = 0; i < step.files.length; i++) {
    const file = step.files[i];
    if (!file.filename) {
      throw new Error(`setConfigFiles files[${i}]: 'filename' is required.`);
    }
    if (!hasData(file.data)) {
      throw new Error(
        `setConfigFiles files[${i}]: 'data' is required (URL, @reference, or resource descriptor).`,
      );
    }
    const bytes = await resources.resolve(file.data);
    const tmpPath = `/tmp/blueprint-configfiles-${++fileCounter}-${Date.now()}.bin`;
    await php.writeFile(tmpPath, bytes);
    fileSpecs.push({
      filename: file.filename,
      filepath: file.filepath || step.filepath || "/",
      tmppath: tmpPath,
      author: file.author ?? step.author ?? null,
      license: file.license ?? step.license ?? null,
      source: file.source ?? step.source ?? null,
      userid: file.userid ?? step.userid ?? null,
    });
  }

  const code = phpSetConfigFiles({
    plugin: step.plugin,
    name: step.name,
    filearea: step.filearea || step.name,
    itemid: step.itemid ?? 0,
    replace: step.replace !== false,
    setConfigValue: step.setConfigValue !== false,
    purgeCaches: step.purgeCaches === true,
    files: fileSpecs,
  });
  const result = await php.run(code);
  assertPhpOk(result, `setConfigFiles '${step.name}'`);
}
