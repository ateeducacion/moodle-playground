import { resolveBootstrapArchive } from "../../lib/moodle-loader.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function splitPath(path) {
  return path.split("/").filter(Boolean);
}

export async function ensureDir(php, path) {
  const parts = splitPath(path);
  let current = "";

  for (const part of parts) {
    current += `/${part}`;

    const about = await php.analyzePath(current);

    if (about?.exists) {
      if (about.object?.isFolder) {
        continue;
      }

      throw new Error(`Cannot create directory ${current}: path exists and is not a directory.`);
    }

    await php.mkdir(current);
  }
}

export async function readJsonFile(php, path) {
  const about = await php.analyzePath(path);

  if (!about?.exists) {
    return null;
  }

  const data = await php.readFile(path);
  return JSON.parse(textDecoder.decode(data));
}

export async function writeJsonFile(php, path, value) {
  await php.writeFile(path, textEncoder.encode(`${JSON.stringify(value, null, 2)}\n`));
}

export { resolveBootstrapArchive };
