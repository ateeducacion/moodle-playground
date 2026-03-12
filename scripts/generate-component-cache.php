#!/usr/bin/env php
<?php

declare(strict_types=1);

if ($argc < 3) {
    fwrite(STDERR, "Usage: generate-component-cache.php <source-dir> <output-file> [runtime-dirroot]\n");
    exit(1);
}

$sourceDir = realpath($argv[1]);
$outputFile = $argv[2];
$runtimeDirroot = $argv[3] ?? '/www/moodle';

if ($sourceDir === false || !is_dir($sourceDir)) {
    fwrite(STDERR, "Source directory not found: {$argv[1]}\n");
    exit(1);
}

if (!is_dir(dirname($outputFile))) {
    mkdir(dirname($outputFile), 0777, true);
}

$configFile = $sourceDir . '/config.php';
$tempDataroot = sys_get_temp_dir() . '/moodle-component-cache-' . bin2hex(random_bytes(6));
$escapedDataroot = addslashes($tempDataroot);
$escapedOutput = addslashes($outputFile);

mkdir($tempDataroot, 0777, true);

$cleanup = static function () use ($configFile, $tempDataroot): void {
    if (file_exists($configFile)) {
        @unlink($configFile);
    }

    if (is_dir($tempDataroot)) {
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($tempDataroot, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );

        foreach ($iterator as $entry) {
            if ($entry->isDir()) {
                @rmdir($entry->getPathname());
            } else {
                @unlink($entry->getPathname());
            }
        }

        @rmdir($tempDataroot);
    }
};

register_shutdown_function($cleanup);

$config = <<<'PHP'
<?php
unset($CFG);
global $CFG;
$CFG = new stdClass();
$CFG->wwwroot = 'http://localhost';
$CFG->dataroot = '__DATAROOT__';
$CFG->admin = 'admin';
$CFG->directorypermissions = 0777;
$CFG->alternative_component_cache = '__OUTPUT__';
define('NO_DEBUG_DISPLAY', true);
define('MOODLE_INTERNAL', false);
require_once(__DIR__ . '/lib/setup.php');
PHP;

$config = str_replace(
    ['__DATAROOT__', '__OUTPUT__'],
    [$escapedDataroot, $escapedOutput],
    $config
);

if (file_put_contents($configFile, $config) === false) {
    fwrite(STDERR, "Unable to write temporary config.php for component cache generation\n");
    exit(1);
}

$command = escapeshellarg(PHP_BINARY)
    . ' '
    . escapeshellarg($sourceDir . '/admin/cli/alternative_component_cache.php')
    . ' --rebuild';

$descriptorSpec = [
    0 => ['pipe', 'r'],
    1 => ['pipe', 'w'],
    2 => ['pipe', 'w'],
];

$process = proc_open($command, $descriptorSpec, $pipes, $sourceDir);

if (!is_resource($process)) {
    fwrite(STDERR, "Unable to spawn Moodle alternative_component_cache.php\n");
    exit(1);
}

fclose($pipes[0]);
$stdout = stream_get_contents($pipes[1]);
$stderr = stream_get_contents($pipes[2]);
fclose($pipes[1]);
fclose($pipes[2]);

$exitCode = proc_close($process);

if ($exitCode !== 0) {
    fwrite(STDERR, trim($stderr ?: $stdout) . "\n");
    exit($exitCode ?: 1);
}

if (!file_exists($outputFile)) {
    fwrite(STDERR, "The Moodle alternative component cache script did not create {$outputFile}\n");
    exit(1);
}

$cache = file_get_contents($outputFile);
if ($cache === false) {
    fwrite(STDERR, "Unable to read generated component cache {$outputFile}\n");
    exit(1);
}

$normalizedSourceDir = str_replace('\\', '/', $sourceDir);
$normalizedRuntimeDir = rtrim(str_replace('\\', '/', $runtimeDirroot), '/');
$cache = str_replace($normalizedSourceDir, $normalizedRuntimeDir, $cache);

if (file_put_contents($outputFile, $cache) === false) {
    fwrite(STDERR, "Unable to rewrite generated component cache {$outputFile}\n");
    exit(1);
}
