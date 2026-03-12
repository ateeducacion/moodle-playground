<?php
// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.

/**
 * PDO wrapper that translates MySQL SQL to SQLite SQL using the WordPress
 * sqlite-database-integration AST engine.
 *
 * @package    core_dml
 * @copyright  2026
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

/**
 * A PDO-like wrapper that intercepts SQL and translates MySQL → SQLite.
 *
 * This wraps WP_PDO_MySQL_On_SQLite (which extends PDO and handles the
 * actual MySQL→SQLite translation) and adds prepare() support needed by
 * Moodle's pdo_moodle_database base class.
 */
class sqlite_translating_pdo {
    /** @var WP_PDO_MySQL_On_SQLite The AST-based MySQL→SQLite translator */
    private $translator;

    /** @var PDO The real underlying SQLite PDO connection */
    private $sqlite_pdo;

    /** @var int Default fetch mode */
    private $default_fetch_mode = PDO::FETCH_BOTH;

    /**
     * Constructor.
     *
     * @param string $dbpath Path to the SQLite database file
     * @param string $dbname Logical database name for the translator
     */
    public function __construct(string $dbpath, string $dbname = 'moodle') {
        $this->sqlite_pdo = new PDO('sqlite:' . $dbpath);
        $this->sqlite_pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->sqlite_pdo->setAttribute(PDO::ATTR_STRINGIFY_FETCHES, true);

        $this->translator = new WP_PDO_MySQL_On_SQLite(
            'mysql-on-sqlite:dbname=' . $dbname,
            null,
            null,
            [
                'pdo' => $this->sqlite_pdo,
                'mysql_version' => 80038,
            ]
        );
    }

    /**
     * Prepare a MySQL statement for execution.
     *
     * Returns a statement object that translates MySQL → SQLite on execute().
     *
     * @param string $sql MySQL SQL statement with ? or :named placeholders
     * @param array $options Driver options (ignored)
     * @return sqlite_translating_statement
     */
    public function prepare($sql, $options = []) {
        return new sqlite_translating_statement($this, $sql);
    }

    /**
     * Execute a MySQL query and return a statement.
     *
     * @param string $sql MySQL SQL query
     * @param int|null $fetch_mode Optional fetch mode
     * @param mixed ...$fetch_mode_args Additional fetch mode arguments
     * @return PDOStatement|WP_PDO_Proxy_Statement
     */
    public function query($sql, $fetch_mode = null, ...$fetch_mode_args) {
        if ($fetch_mode !== null) {
            return $this->translator->query($sql, $fetch_mode, ...$fetch_mode_args);
        }
        return $this->translator->query($sql);
    }

    /**
     * Execute a MySQL statement and return the number of affected rows.
     *
     * @param string $sql MySQL SQL statement
     * @return int|false
     */
    public function exec($sql) {
        return $this->translator->exec($sql);
    }

    /**
     * Quote a string for use in a query.
     *
     * @param string $string The string to quote
     * @param int $type The PDO parameter type
     * @return string|false
     */
    public function quote($string, $type = PDO::PARAM_STR) {
        return $this->sqlite_pdo->quote($string, $type);
    }

    /**
     * Get the ID of the last inserted row.
     *
     * @param string|null $name Name of the sequence object (ignored for SQLite)
     * @return string|false
     */
    public function lastInsertId($name = null) {
        return $this->translator->get_insert_id();
    }

    /**
     * Start a transaction.
     *
     * @return bool
     */
    public function beginTransaction() {
        return $this->translator->beginTransaction();
    }

    /**
     * Commit a transaction.
     *
     * @return bool
     */
    public function commit() {
        return $this->translator->commit();
    }

    /**
     * Roll back a transaction.
     *
     * @return bool
     */
    public function rollBack() {
        return $this->translator->rollBack();
    }

    /**
     * Check if inside a transaction.
     *
     * @return bool
     */
    public function inTransaction() {
        return $this->translator->inTransaction();
    }

    /**
     * Set an attribute on the PDO connection.
     *
     * @param int $attribute
     * @param mixed $value
     * @return bool
     */
    public function setAttribute($attribute, $value) {
        if ($attribute === PDO::ATTR_DEFAULT_FETCH_MODE) {
            $this->default_fetch_mode = $value;
        }
        try {
            return $this->translator->setAttribute($attribute, $value);
        } catch (\Throwable $e) {
            // Some attributes may not be supported by the translator.
            return $this->sqlite_pdo->setAttribute($attribute, $value);
        }
    }

    /**
     * Get an attribute from the PDO connection.
     *
     * @param int $attribute
     * @return mixed
     */
    public function getAttribute($attribute) {
        try {
            return $this->translator->getAttribute($attribute);
        } catch (\Throwable $e) {
            return $this->sqlite_pdo->getAttribute($attribute);
        }
    }

    /**
     * Get the SQLSTATE error code.
     *
     * @return string|null
     */
    public function errorCode() {
        return $this->sqlite_pdo->errorCode();
    }

    /**
     * Get error information.
     *
     * @return array
     */
    public function errorInfo() {
        return $this->sqlite_pdo->errorInfo();
    }

    /**
     * Get the real underlying SQLite PDO connection.
     *
     * @return PDO
     */
    public function getSqlitePdo() {
        return $this->sqlite_pdo;
    }

    /**
     * Get the default fetch mode.
     *
     * @return int
     */
    public function getDefaultFetchMode() {
        return $this->default_fetch_mode;
    }

    /**
     * Register a user-defined function for use in SQL statements.
     *
     * @param string $function_name
     * @param callable $callback
     * @param int $num_args
     * @return bool
     */
    public function sqliteCreateFunction($function_name, $callback, $num_args = -1) {
        return $this->sqlite_pdo->sqliteCreateFunction($function_name, $callback, $num_args);
    }

    /**
     * Delegate any other method calls to the translator.
     *
     * @param string $name Method name
     * @param array $args Method arguments
     * @return mixed
     */
    public function __call($name, $args) {
        return $this->translator->$name(...$args);
    }
}

/**
 * A PDOStatement-like object returned by sqlite_translating_pdo::prepare().
 *
 * Stores the MySQL SQL and translates it on execute(), delegating the actual
 * execution to the WP_PDO_MySQL_On_SQLite translator.
 */
class sqlite_translating_statement {
    /** @var sqlite_translating_pdo */
    private $pdo;

    /** @var string The original MySQL SQL */
    private $sql;

    /** @var array Bound parameter values */
    private $bound_params = [];

    /** @var PDOStatement|WP_PDO_Proxy_Statement|null The result statement */
    private $result = null;

    /** @var int Fetch mode for this statement */
    private $fetch_mode = null;

    /**
     * Constructor.
     *
     * @param sqlite_translating_pdo $pdo
     * @param string $sql MySQL SQL with placeholders
     */
    public function __construct(sqlite_translating_pdo $pdo, string $sql) {
        $this->pdo = $pdo;
        $this->sql = $sql;
    }

    /**
     * Bind a value to a parameter.
     *
     * @param int|string $param Parameter identifier
     * @param mixed $value The value to bind
     * @param int $type PDO parameter type
     * @return bool
     */
    public function bindValue($param, $value, $type = PDO::PARAM_STR) {
        $this->bound_params[$param] = ['value' => $value, 'type' => $type];
        return true;
    }

    /**
     * Bind a parameter to a variable reference.
     *
     * @param int|string $param Parameter identifier
     * @param mixed &$var Reference to the variable
     * @param int $type PDO parameter type
     * @param int|null $maxLength Maximum data length
     * @param mixed $driverOptions Driver-specific options
     * @return bool
     */
    public function bindParam($param, &$var, $type = PDO::PARAM_STR, $maxLength = null, $driverOptions = null) {
        $this->bound_params[$param] = ['value' => &$var, 'type' => $type];
        return true;
    }

    /**
     * Execute the prepared statement.
     *
     * Substitutes parameters into the MySQL SQL and passes the full query
     * through the AST translator for execution.
     *
     * @param array|null $params Parameter values to substitute
     * @return bool
     */
    public function execute($params = null) {
        $sql = $this->sql;
        $merged_params = $params ?? [];

        // Merge bound params with execute params.
        foreach ($this->bound_params as $key => $info) {
            if (!array_key_exists($key, $merged_params)) {
                $merged_params[$key] = $info['value'];
            }
        }

        if (!empty($merged_params)) {
            $sql = $this->substitute_params($sql, $merged_params);
        }

        try {
            $this->result = $this->pdo->query($sql);
            return true;
        } catch (\Throwable $e) {
            throw new \PDOException($e->getMessage(), 0, $e);
        }
    }

    /**
     * Substitute parameter placeholders with quoted values.
     *
     * @param string $sql SQL with placeholders
     * @param array $params Parameter values
     * @return string SQL with substituted values
     */
    private function substitute_params(string $sql, array $params): string {
        // Check if we have named params (:name) or positional params (?).
        $has_named = false;
        foreach ($params as $key => $value) {
            if (is_string($key)) {
                $has_named = true;
                break;
            }
        }

        if ($has_named) {
            // Sort by key length descending to avoid partial replacements.
            $keys = array_keys($params);
            usort($keys, function ($a, $b) {
                return strlen((string)$b) - strlen((string)$a);
            });

            foreach ($keys as $key) {
                $value = $params[$key];
                $placeholder = (strpos($key, ':') === 0) ? $key : ':' . $key;
                $quoted = $this->quote_param($value);
                // Use word boundary to avoid partial replacements.
                $sql = preg_replace(
                    '/' . preg_quote($placeholder, '/') . '(?![a-zA-Z0-9_])/',
                    $quoted,
                    $sql
                );
            }
        } else {
            // Positional parameters - replace ? one at a time.
            $offset = 0;
            $param_index = 0;
            $param_values = array_values($params);
            while (($pos = strpos($sql, '?', $offset)) !== false) {
                if ($param_index >= count($param_values)) {
                    break;
                }
                $quoted = $this->quote_param($param_values[$param_index]);
                $sql = substr($sql, 0, $pos) . $quoted . substr($sql, $pos + 1);
                $offset = $pos + strlen($quoted);
                $param_index++;
            }
        }

        return $sql;
    }

    /**
     * Quote a parameter value for safe inclusion in SQL.
     *
     * @param mixed $value The value to quote
     * @return string The quoted value
     */
    private function quote_param($value): string {
        if ($value === null) {
            return 'NULL';
        }
        if (is_bool($value)) {
            return $value ? '1' : '0';
        }
        if (is_int($value) || is_float($value)) {
            return (string)$value;
        }
        return $this->pdo->quote((string)$value);
    }

    /**
     * Fetch the next row from the result set.
     *
     * @param int $mode Fetch mode
     * @param int $cursorOrientation Cursor orientation
     * @param int $cursorOffset Cursor offset
     * @return mixed
     */
    public function fetch($mode = null, $cursorOrientation = PDO::FETCH_ORI_NEXT, $cursorOffset = 0) {
        if ($this->result === null) {
            return false;
        }
        $effective_mode = $mode ?: ($this->fetch_mode ?: $this->pdo->getDefaultFetchMode());
        return $this->result->fetch($effective_mode, $cursorOrientation, $cursorOffset);
    }

    /**
     * Fetch all remaining rows.
     *
     * @param int|null $mode Fetch mode
     * @param mixed ...$args Additional fetch mode arguments
     * @return array
     */
    public function fetchAll($mode = null, ...$args) {
        if ($this->result === null) {
            return [];
        }
        $effective_mode = $mode ?: ($this->fetch_mode ?: $this->pdo->getDefaultFetchMode());
        return $this->result->fetchAll($effective_mode, ...$args);
    }

    /**
     * Fetch a single column from the next row.
     *
     * @param int $column Column index (0-based)
     * @return mixed
     */
    public function fetchColumn($column = 0) {
        if ($this->result === null) {
            return false;
        }
        return $this->result->fetchColumn($column);
    }

    /**
     * Fetch the next row as an object.
     *
     * @param string $class Class name
     * @param array $constructorArgs Constructor arguments
     * @return object|false
     */
    public function fetchObject($class = 'stdClass', $constructorArgs = []) {
        if ($this->result === null) {
            return false;
        }
        return $this->result->fetchObject($class, $constructorArgs);
    }

    /**
     * Get the number of rows affected by the last statement.
     *
     * @return int
     */
    public function rowCount() {
        if ($this->result === null) {
            return 0;
        }
        return $this->result->rowCount();
    }

    /**
     * Get the number of columns in the result set.
     *
     * @return int
     */
    public function columnCount() {
        if ($this->result === null) {
            return 0;
        }
        return $this->result->columnCount();
    }

    /**
     * Set the fetch mode for this statement.
     *
     * @param int $mode Fetch mode
     * @param mixed ...$args Additional arguments
     * @return bool
     */
    public function setFetchMode($mode, ...$args) {
        $this->fetch_mode = $mode;
        if ($this->result !== null) {
            return $this->result->setFetchMode($mode, ...$args);
        }
        return true;
    }

    /**
     * Close the cursor.
     *
     * @return bool
     */
    public function closeCursor() {
        $this->result = null;
        return true;
    }

    /**
     * Get error code.
     *
     * @return string|null
     */
    public function errorCode() {
        return $this->pdo->errorCode();
    }

    /**
     * Get error info.
     *
     * @return array
     */
    public function errorInfo() {
        return $this->pdo->errorInfo();
    }
}
