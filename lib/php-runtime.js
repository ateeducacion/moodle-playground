import { DEFAULT_BOOT_OPTIONS } from "./constants.js";
import { PGlite, PhpWeb } from "./runtime-imports.js";

export { PhpWeb, PGlite };

export function buildPhpWebOptions(overrides = {}) {
  return {
    PGlite,
    locateFile: (path) => `/node_modules/php-wasm/${path}`,
    ini: `
date.timezone=${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
max_input_vars=5000
memory_limit=512M
`,
    ...overrides,
  };
}

export async function createDirectProbe(overrides = {}) {
  const php = new PhpWeb(buildPhpWebOptions(overrides));
  const dbHost = overrides.dbHost ?? DEFAULT_BOOT_OPTIONS.dbHost;
  const output = [];

  php.addEventListener("output", (event) => output.push(event.detail));
  await php.run(`<?php
echo "pdo-pglite bootstrap probe\\n";
echo "dbhost=${dbHost}\\n";
`);

  return {
    php,
    output: output.join(""),
  };
}
