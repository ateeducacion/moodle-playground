import { promises as fs } from "node:fs";
import path from "node:path";

const [version, outputArg, fileCountArg] = process.argv.slice(2);

if (!version || !outputArg) {
  console.error("Usage: node scripts/build-moodle-manifest.mjs <version> <output> [fileCount]");
  process.exit(1);
}

const output = path.resolve(outputArg);

const manifest = {
  version,
  entryUrl: "install.php",
  bundle: "./moodle.tar",
  fileCount: Number.parseInt(fileCountArg || "0", 10) || 0,
};

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(manifest, null, 2) + "\n", "utf8");
