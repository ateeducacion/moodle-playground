#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, "..");
const vendorDir = resolve(repoDir, "vendor");
const extensionPackages = [
  "php-wasm-iconv",
  "php-wasm-intl",
  "php-wasm-libxml",
  "php-wasm-dom",
  "php-wasm-simplexml",
  "php-wasm-xml",
  "php-wasm-libzip",
  "php-wasm-mbstring",
  "php-wasm-openssl",
  "php-wasm-zlib",
  "php-wasm-phar",
  "php-wasm-sqlite",
];

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function copyTree(sourceDir, targetDir, transform = null) {
  const entries = readdirSync(sourceDir);
  ensureDir(targetDir);

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry);
    const stats = statSync(sourcePath);

    if (stats.isDirectory()) {
      copyTree(sourcePath, join(targetDir, entry), transform);
      continue;
    }

    const transformed = transform ? transform(sourcePath, join(targetDir, entry)) : null;

    if (transformed) {
      ensureDir(dirname(transformed.path));
      writeFileSync(transformed.path, transformed.contents);
      continue;
    }

    ensureDir(dirname(join(targetDir, entry)));
    cpSync(sourcePath, join(targetDir, entry));
  }
}

function transformPhpEsm(sourcePath, targetPath) {
  const extension = extname(sourcePath);

  if (extension === ".mjs") {
    const contents = readFileSync(sourcePath, "utf8").replaceAll(".mjs", ".js");
    return {
      path: targetPath.replace(/\.mjs$/u, ".js"),
      contents,
    };
  }

  if (extension === ".wasm" || extension === ".so") {
    return null;
  }

  return {
    path: `${targetPath}.skip`,
    contents: "",
  };
}

function copyPhpRuntime(packageName, targetName) {
  const sourceDir = resolve(repoDir, "node_modules", packageName);
  const targetDir = resolve(vendorDir, targetName);

  rmSync(targetDir, { recursive: true, force: true });
  copyTree(sourceDir, targetDir, (sourcePath, targetPath) => {
    const extension = extname(sourcePath);

    if (extension === ".mjs") {
      const contents = readFileSync(sourcePath, "utf8").replaceAll(".mjs", ".js");
      return {
        path: targetPath.replace(/\.mjs$/u, ".js"),
        contents,
      };
    }

    if (extension === ".wasm" || extension === ".so") {
      return null;
    }

    return {
      path: `${targetPath}.skip`,
      contents: "",
    };
  });

  for (const skipPath of readdirSync(targetDir, { recursive: true }).filter((entry) => entry.endsWith(".skip"))) {
    rmSync(join(targetDir, skipPath), { force: true });
  }
}

function patchPhpCgiBase(targetDir) {
  const patchFile = (fileName) => {
    const filePath = resolve(targetDir, fileName);
    const original = readFileSync(filePath, "utf8");
    let patched = original.replace(
      "putEnv(php, 'HTTP_HOST', selfUrl.host);",
      [
        "putEnv(php, 'HTTP_HOST', selfUrl.host);",
        "putEnv(php, 'SERVER_NAME', selfUrl.hostname);",
        "putEnv(php, 'SERVER_PORT', selfUrl.port || (protocol === 'https' ? '443' : '80'));",
        "putEnv(php, 'SERVER_PROTOCOL', 'HTTP/1.1');",
      ].join("\n\t\t"),
    );

    patched = patched.replace(
      "putEnv(php, 'DOCUMENT_ROOT', docroot);",
      [
        "putEnv(php, 'DOCUMENT_ROOT', docroot);",
        "const docrootScriptName = path.startsWith(docroot)",
        "\t\t\t? path.substring(docroot.length) || '/'",
        "\t\t\t: scriptName;",
      ].join("\n\t\t"),
    );

    patched = patched.replace(
      "putEnv(php, 'SCRIPT_NAME', scriptName);",
      "putEnv(php, 'SCRIPT_NAME', docrootScriptName.startsWith('/') ? docrootScriptName : `/${docrootScriptName}`);",
    );

    writeFileSync(filePath, patched, "utf8");
  };

  patchFile("PhpCgiBase.js");
}

function copyBrowserPackage(packageName) {
  const sourceDir = resolve(repoDir, "node_modules", packageName);
  const targetDir = resolve(vendorDir, packageName);

  rmSync(targetDir, { recursive: true, force: true });
  copyTree(sourceDir, targetDir, (sourcePath, targetPath) => {
    const extension = extname(sourcePath);

    if (extension === ".mjs") {
      const contents = readFileSync(sourcePath, "utf8")
        .replaceAll(".mjs", ".js")
        .replace(
          /const moduleRoot = url \+ \(String\(url\)\.substr\(-10\) !== '\/index\.js' \? '\/' : ''\);/g,
          "const moduleRoot = new URL('./', importMeta.url);",
        );
      return {
        path: targetPath.replace(/\.mjs$/u, ".js"),
        contents,
      };
    }

    return null;
  });
}

rmSync(resolve(vendorDir, "php-wasm"), { recursive: true, force: true });
rmSync(resolve(vendorDir, "php-cgi-wasm"), { recursive: true, force: true });
rmSync(resolve(vendorDir, "fflate-browser.js"), { force: true });
for (const packageName of extensionPackages) {
  rmSync(resolve(vendorDir, packageName), { recursive: true, force: true });
}

copyPhpRuntime("php-wasm", "php-wasm");
copyPhpRuntime("php-cgi-wasm", "php-cgi-wasm");
patchPhpCgiBase(resolve(vendorDir, "php-cgi-wasm"));
for (const packageName of extensionPackages) {
  copyBrowserPackage(packageName);
}
cpSync(
  resolve(repoDir, "node_modules", "fflate", "esm", "browser.js"),
  resolve(vendorDir, "fflate-browser.js"),
);

console.log(`Synced browser dependencies into ${relative(repoDir, vendorDir) || "vendor"}`);
