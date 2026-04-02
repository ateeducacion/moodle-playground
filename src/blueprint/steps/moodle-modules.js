import { phpAddModule } from "../php/helpers.js";

export function registerMoodleModuleSteps(register) {
  register("addModule", handleAddModule);
}

async function handleAddModule(step, { php, publish, resources }) {
  if (!step.module) throw new Error("addModule: 'module' type is required.");
  if (!step.course)
    throw new Error("addModule: 'course' shortname is required.");

  // Resolve file resources to temporary VFS paths so the generated PHP
  // can attach them to the module via Moodle's file storage API.
  const fileSpecs = [];
  if (Array.isArray(step.files) && step.files.length > 0) {
    for (let i = 0; i < step.files.length; i++) {
      const file = step.files[i];
      if (!file.filename) {
        throw new Error(`addModule files[${i}]: 'filename' is required.`);
      }
      if (!file.data) {
        throw new Error(
          `addModule files[${i}]: 'data' is required (URL, @reference, or resource descriptor).`,
        );
      }
      const data = await resources.resolve(file.data);
      const tmpPath = `/tmp/blueprint-modfile-${i}-${Date.now()}.bin`;
      await php.writeFile(tmpPath, data);
      fileSpecs.push({
        filearea: file.filearea || "content",
        itemid: file.itemid ?? 0,
        filepath: file.filepath || "/",
        filename: file.filename,
        tmppath: tmpPath,
      });
    }
  }

  const code = phpAddModule(step, fileSpecs);
  let result;
  try {
    result = await php.run(code);
  } catch (err) {
    // php.run() throws on non-zero exit code. Check stdout for success.
    const stdout = err.message
      ?.match(/=== Stdout ===\s*([\s\S]*?)(?:=== Stderr|$)/)?.[1]
      ?.trim();
    if (stdout?.includes('"ok":true')) {
      return;
    }
    const detail = `addModule ${step.module} failed: ${String(err.message || err).slice(0, 150)}`;
    if (publish) publish(detail, 0.95);
    throw new Error(detail);
  }
  const text = result?.text || "";
  const errors = result?.errors || "";
  if (errors && publish) {
    publish(
      `addModule ${step.module} PHP errors: ${errors.slice(0, 200)}`,
      0.95,
    );
  }
  if (text?.includes('"ok":false')) {
    const detail = `addModule ${step.module} failed: ${text.slice(0, 200)}`;
    if (publish) publish(detail, 0.95);
    throw new Error(detail);
  }
}
