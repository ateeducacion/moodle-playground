/**
 * Filesystem step handlers: mkdir, rmdir, writeFile, writeFiles, copyFile, moveFile, unzip.
 */
import { readZipEntries } from "../../../lib/moodle-loader.js";
import { escapePhp } from "../php/helpers.js";

export function registerFilesystemSteps(register) {
  register("mkdir", handleMkdir);
  register("rmdir", handleRmdir);
  register("writeFile", handleWriteFile);
  register("writeFiles", handleWriteFiles);
  register("copyFile", handleCopyFile);
  register("moveFile", handleMoveFile);
  register("unzip", handleUnzip);
}

async function handleMkdir(step, { php }) {
  const path = step.path;
  if (!path) throw new Error("mkdir: 'path' is required.");

  // Recursive mkdir by creating each segment
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const seg of segments) {
    current += `/${seg}`;
    try {
      await php.run(`<?php @mkdir('${escapePhp(current)}', 0777);`);
    } catch {
      /* already exists */
    }
  }
}

async function handleRmdir(step, { php }) {
  const path = step.path;
  if (!path) throw new Error("rmdir: 'path' is required.");
  const recursive = step.recursive ? "true" : "false";
  await php.run(`<?php
function rrmdir($dir, $recursive) {
    if (!is_dir($dir)) return;
    if ($recursive) {
        $items = scandir($dir);
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') continue;
            $path = $dir . '/' . $item;
            is_dir($path) ? rrmdir($path, true) : unlink($path);
        }
    }
    rmdir($dir);
}
rrmdir('${escapePhp(path)}', ${recursive});
echo json_encode(['ok' => true]);
`);
}

async function handleWriteFile(step, { php, resources }) {
  const path = step.path;
  if (!path) throw new Error("writeFile: 'path' is required.");

  let data;
  if (step.data && typeof step.data === "string" && step.data.startsWith("@")) {
    data = await resources.resolve(step.data);
  } else if (
    step.data &&
    typeof step.data === "object" &&
    !Array.isArray(step.data)
  ) {
    data = await resources.resolve(step.data);
  } else if (typeof step.data === "string") {
    data = new TextEncoder().encode(step.data);
  } else {
    throw new Error(
      "writeFile: 'data' is required (string, @reference, or resource descriptor).",
    );
  }

  await php.writeFile(path, data);
}

async function handleWriteFiles(step, { php, resources }) {
  if (!Array.isArray(step.files))
    throw new Error("writeFiles: 'files' must be an array.");

  for (const file of step.files) {
    await handleWriteFile(
      { path: file.path, data: file.data },
      { php, resources },
    );
  }
}

async function handleCopyFile(step, { php }) {
  const { from, to } = step;
  if (!from || !to) throw new Error("copyFile: 'from' and 'to' are required.");

  const data = await php.readFile(from);
  await php.writeFile(to, data);
}

async function handleMoveFile(step, { php }) {
  const { from, to } = step;
  if (!from || !to) throw new Error("moveFile: 'from' and 'to' are required.");

  const data = await php.readFile(from);
  await php.writeFile(to, data);
  await php.run(`<?php @unlink('${escapePhp(from)}');`);
}

async function handleUnzip(step, { php, resources }) {
  const destination = step.destination || step.path;
  if (!destination)
    throw new Error("unzip: 'destination' (or 'path') is required.");

  if (!step.data) {
    throw new Error("unzip: 'data' is required.");
  }
  const zipBytes = await resources.resolve(step.data);
  const entries = await readZipEntries(zipBytes);

  const rawPhp = php._php;
  for (const { path, data } of entries) {
    const fullPath = `${destination}/${path}`;
    const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (parentDir) {
      rawPhp.mkdirTree(parentDir);
    }
    rawPhp.writeFile(fullPath, data);
  }
}
