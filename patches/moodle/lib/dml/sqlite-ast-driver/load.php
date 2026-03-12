<?php
/**
 * Loader for the WordPress sqlite-database-integration AST driver.
 *
 * This loads all necessary classes for translating MySQL SQL to SQLite SQL.
 * Vendored from WordPress/sqlite-database-integration v2.2.18.
 */

$dir = __DIR__;

require_once $dir . '/version.php';
require_once $dir . '/php-polyfills.php';
require_once $dir . '/parser/class-wp-parser-grammar.php';
require_once $dir . '/parser/class-wp-parser.php';
require_once $dir . '/parser/class-wp-parser-node.php';
require_once $dir . '/parser/class-wp-parser-token.php';
require_once $dir . '/mysql/class-wp-mysql-token.php';
require_once $dir . '/mysql/class-wp-mysql-lexer.php';
require_once $dir . '/mysql/class-wp-mysql-parser.php';
require_once $dir . '/sqlite/class-wp-sqlite-pdo-user-defined-functions.php';
require_once $dir . '/sqlite-ast/class-wp-sqlite-connection.php';
require_once $dir . '/sqlite-ast/class-wp-sqlite-configurator.php';
require_once $dir . '/sqlite-ast/class-wp-sqlite-driver.php';
require_once $dir . '/sqlite-ast/class-wp-sqlite-driver-exception.php';
require_once $dir . '/sqlite-ast/class-wp-sqlite-information-schema-builder.php';
require_once $dir . '/sqlite-ast/class-wp-sqlite-information-schema-exception.php';
require_once $dir . '/sqlite-ast/class-wp-sqlite-information-schema-reconstructor.php';
require_once $dir . '/sqlite-ast/class-wp-pdo-mysql-on-sqlite.php';
require_once $dir . '/sqlite-ast/class-wp-pdo-proxy-statement.php';
