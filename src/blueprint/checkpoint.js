import { isEphemeralMoodlePath } from "../shared/paths.js";
import { escapePhp } from "./php/helpers.js";

// See docs/architecture/adr/ADR-0035-blueprint-reload-checkpoints.md.
// shortcut: arbitrary runtime /www edits remain volatile; managed-code persistence needs a separate ADR.
export async function createBlueprintCheckpoint({
  blueprint,
  php,
  dbFile,
  resume,
}) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(blueprint)),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const query = await php.run(`<?php
$pdo = new PDO('sqlite:${escapePhp(dbFile)}');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$value = $pdo->query("SELECT value FROM mdl_config WHERE name = 'playground_blueprint_checkpoint'")->fetchColumn();
echo json_encode($value === false ? null : (json_decode($value, true) ?? ['invalid' => true]));
`);
  const stored = JSON.parse(query.text);
  const matches =
    stored?.version === 1 &&
    stored.fingerprint === fingerprint &&
    Array.isArray(stored.completed) &&
    stored.completed.every(
      (index) =>
        Number.isInteger(index) && index >= 0 && index < blueprint.steps.length,
    );
  const completed = new Set(matches ? stored.completed : []);
  const checkpoint = {
    fingerprint,
    completed,
    resuming: Boolean(resume),
    legacy: Boolean(resume && stored === null),
    // The source key can stay the same while its content changes (edited
    // blueprint-url, new default). Keep the data; replay only login/landing.
    changed: Boolean(stored !== null && !matches),
    async save(index) {
      const next = new Set(completed);
      if (index !== undefined) next.add(index);
      const value = JSON.stringify({
        version: 1,
        fingerprint,
        completed: [...next],
      });
      const result = await php.run(`<?php
$pdo = new PDO('sqlite:${escapePhp(dbFile)}');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$statement = $pdo->prepare("INSERT INTO mdl_config (name, value) VALUES ('playground_blueprint_checkpoint', :value) ON CONFLICT(name) DO UPDATE SET value = excluded.value");
$statement->execute([':value' => '${escapePhp(value)}']);
echo 'checkpoint-saved';
`);
      if (result.text.trim() !== "checkpoint-saved")
        throw new Error(
          "Blueprint checkpoint could not be saved; provisioning stopped.",
        );
      if (index !== undefined) completed.add(index);
    },
  };
  // Persist the empty checkpoint before any step can mutate the installed DB.
  if (!resume) await checkpoint.save();
  return checkpoint;
}

export function isVolatilePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\\"))
    return false;
  const segments = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  // Volatile = not journaled: everything outside /persist plus the derived dirs
  // the journal excludes. Never DB/filedir, devices or the bare root.
  const [root] = segments;
  if (!root || ["dev", "proc"].includes(root)) return false;
  return root !== "persist" || isEphemeralMoodlePath(`/${segments.join("/")}`);
}

// Session-only steps that every reload repeats.
export const RUNTIME_STEPS = new Set(["login", "setLandingPage"]);

export function getReloadStep(step, completed, artifactPath) {
  const data = (index) => ({ vfs: `${artifactPath}-${index}.bin` });
  if (RUNTIME_STEPS.has(step.step)) return step;
  if (["installMoodlePlugin", "installTheme"].includes(step.step)) return step;
  if (step.step === "applyPrOverlay")
    return isVolatilePath(step.root || "/www/moodle") ? step : null;
  if (!completed) return null;
  if (step.step === "writeFile")
    return isVolatilePath(step.path) ? { ...step, data: data(0) } : null;
  if (["mkdir", "rmdir", "deleteFile"].includes(step.step))
    return isVolatilePath(step.path) ? step : null;
  if (step.step === "writeFiles") {
    const files = step.files
      .map((file, index) => ({ ...file, data: data(index) }))
      .filter((file) => isVolatilePath(file.path));
    return files.length ? { ...step, files } : null;
  }
  if (step.step === "deleteFiles") {
    const files = step.files.filter((file) =>
      isVolatilePath(typeof file === "string" ? file : file.path),
    );
    return files.length ? { ...step, files } : null;
  }
  if (step.step === "moveFile") {
    if (isVolatilePath(step.to)) return step;
    return isVolatilePath(step.from)
      ? { step: "deleteFile", path: step.from, critical: step.critical }
      : null;
  }
  if (step.step === "copyFile")
    return isVolatilePath(step.to)
      ? {
          step: "writeFile",
          path: step.to,
          data: data(0),
          critical: step.critical,
        }
      : null;
  if (step.step === "unzip")
    return isVolatilePath(step.destination || step.path)
      ? { ...step, data: data(0) }
      : null;
  return null;
}
