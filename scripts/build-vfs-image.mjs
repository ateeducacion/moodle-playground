#!/usr/bin/env node

import { createWriteStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

function listFiles(rootDir) {
  const files = [];

  function walk(currentDir) {
    const entries = readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      files.push(absolutePath);
    }
  }

  walk(rootDir);
  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = resolve(args.source || "");
  const dataPath = resolve(args.data || "");
  const indexPath = resolve(args.index || "");

  if (!args.source || !args.data || !args.index) {
    throw new Error("Usage: build-vfs-image.mjs --source <dir> --data <file> --index <file>");
  }

  const files = listFiles(sourceDir);

  mkdirSync(dirname(dataPath), { recursive: true });
  mkdirSync(dirname(indexPath), { recursive: true });

  const stream = createWriteStream(dataPath);
  const entries = [];
  let offset = 0;

  for (const absolutePath of files) {
    const relativePath = relative(sourceDir, absolutePath).replaceAll("\\", "/");
    const data = readFileSync(absolutePath);
    const stats = statSync(absolutePath);

    await new Promise((resolveWrite, rejectWrite) => {
      stream.write(data, (error) => {
        if (error) {
          rejectWrite(error);
          return;
        }

        resolveWrite();
      });
    });

    entries.push({
      path: relativePath,
      offset,
      size: data.byteLength,
      mtimeMs: Math.trunc(stats.mtimeMs),
      mode: stats.mode,
    });

    offset += data.byteLength;
  }

  await new Promise((resolveStream, rejectStream) => {
    stream.end((error) => {
      if (error) {
        rejectStream(error);
        return;
      }

      resolveStream();
    });
  });

  const index = {
    schemaVersion: 1,
    format: "moodle-vfs-image-v1",
    generatedAt: new Date().toISOString(),
    root: "/",
    fileCount: entries.length,
    totalBytes: offset,
    entries,
  };

  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
