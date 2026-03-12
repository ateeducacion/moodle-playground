import { DEFAULT_BOOT_OPTIONS, PHP_WASM_MODULE_URL } from "./constants.js";

const { PhpWeb } = await import(PHP_WASM_MODULE_URL);

export { PhpWeb };

export function buildPhpWebOptions(overrides = {}) {
  return {
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
  const output = [];

  php.addEventListener("output", (event) => output.push(event.detail));
  await php.run(`<?php
echo "pdo-sqlite bootstrap probe\\n";
echo "drivers=" . implode(',', PDO::getAvailableDrivers()) . "\\n";
`);

  return {
    php,
    output: output.join(""),
  };
}
