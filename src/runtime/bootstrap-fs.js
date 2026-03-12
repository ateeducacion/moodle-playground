import { resolveBootstrapArchive } from "../../lib/moodle-loader.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function splitPath(path) {
  return path.split("/").filter(Boolean);
}

export async function ensureDir(php, path) {
  const binary = await php.binary;
  const { FS } = binary;
  const parts = splitPath(path);
  let current = "";

  for (const part of parts) {
    current += `/${part}`;

    const about = FS.analyzePath(current);

    if (about?.exists) {
      if (about.object && FS.isDir(about.object.mode)) {
        continue;
      }

      throw new Error(`Cannot create directory ${current}: path exists and is not a directory.`);
    }

    FS.mkdir(current);
  }
}

export async function readJsonFile(php, path) {
  const binary = await php.binary;
  const { FS } = binary;
  const about = FS.analyzePath(path);

  if (!about?.exists) {
    return null;
  }

  const data = FS.readFile(path);
  return JSON.parse(textDecoder.decode(data));
}

export async function writeJsonFile(php, path, value) {
  const binary = await php.binary;
  binary.FS.writeFile(path, textEncoder.encode(`${JSON.stringify(value, null, 2)}\n`));
}

export { resolveBootstrapArchive };
