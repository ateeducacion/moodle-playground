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
echo json_encode($value === false ? null : json_decode($value, true, 512, JSON_THROW_ON_ERROR));
`);
  const stored = JSON.parse(query.text);
  if (
    stored !== null &&
    (stored.version !== 1 ||
      stored.fingerprint !== fingerprint ||
      !Array.isArray(stored.completed) ||
      stored.completed.some(
        (index) =>
          !Number.isInteger(index) ||
          index < 0 ||
          index >= blueprint.steps.length,
      ))
  ) {
    throw new Error(
      "Persisted blueprint checkpoint does not match this blueprint; provisioning was not replayed.",
    );
  }
  const completed = new Set(stored?.completed || []);
  const checkpoint = {
    fingerprint,
    completed,
    resuming: Boolean(resume),
    legacy: Boolean(resume && !stored),
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
  // Restore only explicit application/tmp files, never persisted data or devices.
  return ["www", "tmp"].includes(segments[0]);
}

export function getReloadStep(step, completed, artifactPath) {
  const data = (index) => ({ vfs: `${artifactPath}-${index}.bin` });
  if (["login", "setLandingPage"].includes(step.step)) return step;
  if (!completed) return null;
  if (["installMoodlePlugin", "installTheme"].includes(step.step)) return step;
  if (step.step === "applyPrOverlay")
    return isVolatilePath(step.root || "/www/moodle") ? step : null;
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
      ? { step: "deleteFile", path: step.from }
      : null;
  }
  if (step.step === "copyFile")
    return isVolatilePath(step.to)
      ? { step: "writeFile", path: step.to, data: data(0) }
      : null;
  if (step.step === "unzip")
    return isVolatilePath(step.destination || step.path)
      ? { ...step, data: data(0) }
      : null;
  return null;
}
