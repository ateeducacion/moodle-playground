/**
 * Course restore step: restoreCourse.
 *
 * Restores a Moodle course backup (.mbz) into a category using Moodle's own
 * restore_controller. The backup can come from a URL (downloaded inside PHP,
 * streamed straight to MEMFS — the memory-efficient path for large files), an
 * existing MEMFS path, or embedded resource data.
 *
 * Large/complex backups can fail (in-browser memory limits and SQLite-WASM
 * transaction limits); failures are reported gracefully and never abort the
 * blueprint. See docs/decisions/0007-course-restore-step.md.
 */

import { phpRestoreCourse } from "../php/helpers.js";

// Per-session counter for unique temp paths when restoring from embedded data.
let embeddedRestoreCounter = 0;

export function registerMoodleRestoreSteps(register) {
  register("restoreCourse", handleRestoreCourse);
}

function trimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function handleRestoreCourse(step, context) {
  const { php, publish, resources } = context;

  const url = trimmedString(step.url);
  const path = trimmedString(step.path);
  const hasData =
    step.data !== undefined && step.data !== null && step.data !== "";

  if (!url && !path && !hasData) {
    throw new Error(
      "restoreCourse: one of 'url', 'path', or 'data' is required.",
    );
  }
  if (url && !/^https?:\/\//iu.test(url)) {
    throw new Error("restoreCourse: 'url' must be an http(s) URL.");
  }

  if (publish) {
    publish(
      "Restoring course backup — large or complex backups may exceed the in-browser runtime and fail.",
      0.93,
    );
  }

  // Resolve the backup source into options for the PHP generator. Precedence:
  // url > path > embedded data.
  const opts = {
    category: trimmedString(step.category),
    createCategory: step.createCategory !== false,
    fullname: trimmedString(step.fullname),
    shortname: trimmedString(step.shortname),
    visible: step.visible !== false,
  };

  if (url) {
    opts.downloadUrl = url;
  } else if (path) {
    opts.localPath = path;
  } else {
    // Embedded backup: resolve via the resource registry and write to MEMFS.
    // This buffers the whole file in JS, so it is only suitable for small
    // backups — large ones should use `url`.
    const bytes = await resources.resolve(step.data);
    const tempPath = `/tmp/restore_${++embeddedRestoreCounter}.mbz`;
    await php.writeFile(tempPath, bytes);
    opts.localPath = tempPath;
  }

  let result;
  try {
    result = await php.run(phpRestoreCourse(opts));
  } catch (err) {
    // A hard failure (e.g. OOM, nested-savepoint crash) can throw. Don't abort
    // the blueprint — the course is a non-critical add-on.
    if (publish) {
      publish(
        `Course restore crashed: ${String(err.message || err).slice(0, 200)}`,
        0.94,
      );
    }
    return;
  }

  const text = result?.text || "";
  if (publish) {
    if (text.includes('"ok":true')) {
      const idMatch = text.match(/"courseid":(\d+)/u);
      publish(`Course restored${idMatch ? ` (id ${idMatch[1]})` : ""}.`, 0.94);
    } else {
      publish(`Course restore reported issues: ${text.slice(0, 200)}`, 0.94);
    }
  }
}

export const __testables = { trimmedString };
