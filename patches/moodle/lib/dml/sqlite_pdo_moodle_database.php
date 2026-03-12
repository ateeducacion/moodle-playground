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
 * SQLite PDO database class using the WordPress sqlite-database-integration
 * AST translator to convert MySQL SQL to SQLite SQL at runtime.
 *
 * By returning get_dbfamily() = 'mysql', Moodle's XMLDB system uses
 * mysql_sql_generator to produce MySQL DDL. The AST translator converts
 * this to SQLite DDL transparently.
 *
 * @package    core_dml
 * @copyright  2026
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

require_once(__DIR__.'/pdo_moodle_database.php');
require_once(__DIR__.'/moodle_temptables.php');
require_once(__DIR__.'/sqlite_translating_pdo.php');
require_once(__DIR__.'/sqlite-ast-driver/load.php');

/**
 * SQLite PDO database class backed by the WordPress sqlite-database-integration
 * AST MySQL→SQLite translator.
 *
 * @package    core_dml
 * @copyright  2026
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class sqlite_pdo_moodle_database extends pdo_moodle_database {

    /** @var sqlite_translating_pdo */
    protected $pdb;

    /**
     * Connect to the SQLite database.
     *
     * @param string $dbhost Unused for SQLite
     * @param string $dbuser Unused for SQLite
     * @param string $dbpass Unused for SQLite
     * @param string $dbname Path to the SQLite database file
     * @param mixed $prefix Table prefix
     * @param array|null $dboptions Driver options
     * @return bool
     */
    public function connect($dbhost, $dbuser, $dbpass, $dbname, $prefix, ?array $dboptions = null) {
        $driverstatus = $this->driver_installed();

        if ($driverstatus !== true) {
            throw new dml_exception('dbdriverproblem', $driverstatus);
        }

        $this->store_settings($dbhost, $dbuser, $dbpass, $dbname, $prefix, $dboptions);

        // Create the translating PDO wrapper.
        $this->pdb = new sqlite_translating_pdo($dbname, 'moodle');

        // Set standard attributes.
        $this->pdb->setAttribute(\PDO::ATTR_CASE, \PDO::CASE_LOWER);
        $this->pdb->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);

        // Register REGEXP function for SQLite.
        $this->pdb->sqliteCreateFunction('REGEXP', function ($pattern, $subject) {
            if ($pattern === null || $subject === null) {
                return null;
            }
            return @preg_match('/' . str_replace('/', '\/', $pattern) . '/iu', $subject) ? 1 : 0;
        }, 2);

        // Enable WAL mode for better performance.
        try {
            $this->pdb->getSqlitePdo()->exec('PRAGMA journal_mode=WAL');
        } catch (\Throwable $e) {
            // WAL may not be supported in all environments, continue without it.
        }

        // Set busy timeout.
        try {
            $this->pdb->getSqlitePdo()->exec('PRAGMA busy_timeout=10000');
        } catch (\Throwable $e) {
            // Ignore.
        }

        $this->configure_dbconnection();
        $this->temptables = new \moodle_temptables($this);

        return true;
    }

    /**
     * Detects if all needed PHP stuff are installed for DB connectivity.
     *
     * @return mixed true if ok, string error message otherwise
     */
    public function driver_installed() {
        if (!class_exists('PDO')) {
            return 'PHP has not been properly configured with PDO support.';
        }

        if (!in_array('sqlite', \PDO::getAvailableDrivers(), true)) {
            return 'PHP has not been properly configured with the PDO SQLite driver.';
        }

        return true;
    }

    /**
     * Returns database family type - 'mysql' so XMLDB generates MySQL DDL
     * which the AST translator converts to SQLite.
     *
     * @return string
     */
    public function get_dbfamily() {
        return 'mysql';
    }

    /**
     * Returns more specific database driver type.
     *
     * @return string
     */
    protected function get_dbtype() {
        return 'sqlite';
    }

    /**
     * Returns the driver-dependent DSN for PDO.
     *
     * @return string
     */
    protected function get_dsn() {
        return 'sqlite:' . $this->dbname;
    }

    /**
     * No special PDO options needed for SQLite.
     *
     * @return array
     */
    protected function get_pdooptions() {
        return [];
    }

    /**
     * Apply LIMIT/OFFSET clauses (MySQL syntax, translated by AST).
     *
     * @param string $sql
     * @param int $limitfrom
     * @param int $limitnum
     * @return string
     */
    protected function get_limit_clauses($sql, $limitfrom, $limitnum) {
        list($limitfrom, $limitnum) = $this->normalise_limit_from_num($limitfrom, $limitnum);

        if ($limitnum) {
            $sql .= " LIMIT $limitnum";
        }
        if ($limitfrom) {
            $sql .= " OFFSET $limitfrom";
        }

        return $sql;
    }

    /**
     * MySQL LIKE helper (MySQL syntax, translated by AST).
     *
     * @param string $fieldname
     * @param string $param
     * @param bool $casesensitive
     * @param bool $accentsensitive
     * @param bool $notlike
     * @param string $escapechar
     * @return string
     */
    public function sql_like($fieldname, $param, $casesensitive = true, $accentsensitive = true, $notlike = false, $escapechar = '\\') {
        if (strpos($param, '%') !== false) {
            debugging('Potential SQL injection detected, sql_like() expects bound parameters (? or :named)');
        }

        $not = $notlike ? 'NOT ' : '';

        if ($casesensitive) {
            return "$fieldname {$not}LIKE $param ESCAPE '$escapechar'";
        } else {
            // SQLite LIKE is case-insensitive by default for ASCII.
            return "LOWER($fieldname) {$not}LIKE LOWER($param) ESCAPE '$escapechar'";
        }
    }

    /**
     * MySQL bitwise XOR.
     *
     * @param string $int1
     * @param string $int2
     * @return string
     */
    public function sql_bitxor($int1, $int2) {
        // SQLite doesn't have XOR operator, use bitwise AND/OR/NOT.
        return '((' . $int1 . ' | ' . $int2 . ') - (' . $int1 . ' & ' . $int2 . '))';
    }

    /**
     * Cast to char/varchar.
     *
     * @param string $field
     * @return string
     */
    public function sql_cast_to_char(string $field): string {
        return "CAST({$field} AS TEXT)";
    }

    /**
     * Cast char to int.
     *
     * @param string $fieldname
     * @param bool $text
     * @return string
     */
    public function sql_cast_char2int($fieldname, $text = false) {
        return ' CAST(' . $fieldname . ' AS INTEGER) ';
    }

    /**
     * Cast char to real.
     *
     * @param string $fieldname
     * @param bool $text
     * @return string
     */
    public function sql_cast_char2real($fieldname, $text = false) {
        return ' CAST(' . $fieldname . ' AS REAL) ';
    }

    /**
     * String concatenation using MySQL CONCAT() syntax.
     * The AST translator will convert this appropriately.
     *
     * @param mixed ...$arr
     * @return string
     */
    public function sql_concat(...$arr) {
        // Use || operator directly (native SQLite).
        $sql = implode(' || ', $arr);
        if ($sql === '') {
            return " '' ";
        }
        return " ($sql) ";
    }

    /**
     * String concatenation with separator.
     *
     * @param string $separator
     * @param array $elements
     * @return string
     */
    public function sql_concat_join($separator = "' '", $elements = []) {
        for ($index = count($elements) - 1; $index > 0; $index--) {
            array_splice($elements, $index, 0, $separator);
        }

        $sql = implode(' || ', $elements);
        if ($sql === '') {
            return " '' ";
        }

        return " $sql ";
    }

    /**
     * GROUP_CONCAT (native in SQLite).
     *
     * @param string $field
     * @param string $separator
     * @param string $sort
     * @return string
     */
    public function sql_group_concat(string $field, string $separator = ', ', string $sort = ''): string {
        if ($sort) {
            // SQLite GROUP_CONCAT doesn't support ORDER BY directly,
            // but the AST translator may handle it.
            return "GROUP_CONCAT(" . $this->sql_cast_to_char($field) . ", '{$separator}')";
        }
        return "GROUP_CONCAT(" . $this->sql_cast_to_char($field) . ", '{$separator}')";
    }

    /**
     * Order by null handling.
     *
     * @param string $fieldname
     * @param int $sort
     * @return string
     */
    public function sql_order_by_null(string $fieldname, int $sort = SORT_ASC): string {
        // SQLite sorts NULLs first for ASC and last for DESC by default.
        // Use CASE to control ordering.
        if ($sort == SORT_ASC) {
            return "CASE WHEN $fieldname IS NULL THEN 0 ELSE 1 END, $fieldname ASC";
        } else {
            return "CASE WHEN $fieldname IS NULL THEN 1 ELSE 0 END, $fieldname DESC";
        }
    }

    /**
     * REGEXP support.
     *
     * @return bool
     */
    public function sql_regex_supported() {
        return true;
    }

    /**
     * REGEXP operator.
     *
     * @param bool $positivematch
     * @param bool $casesensitive
     * @return string
     */
    public function sql_regex($positivematch = true, $casesensitive = false) {
        // SQLite REGEXP is case-insensitive via our registered function.
        if ($positivematch) {
            return 'REGEXP';
        }
        return 'NOT REGEXP';
    }

    /**
     * Whether text replacement is supported.
     *
     * @return bool
     */
    public function replace_all_text_supported() {
        return true;
    }

    /**
     * Whether fulltext search is supported.
     *
     * @return bool
     */
    public function is_fulltext_search_supported() {
        return false;
    }

    /**
     * Whether count window function is supported.
     *
     * @return bool
     */
    public function is_count_window_function_supported(): bool {
        return true;
    }

    /**
     * Return tables in database WITHOUT current prefix.
     *
     * @param bool $usecache
     * @return array
     */
    public function get_tables($usecache = true) {
        if ($usecache && $this->tables !== null) {
            return $this->tables;
        }

        $this->tables = [];

        $sql = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_wp_sqlite_%'";

        $this->query_start($sql, null, SQL_QUERY_AUX_READONLY);
        try {
            $statement = $this->pdb->query($sql);
            $rows = $statement ? $statement->fetchAll(\PDO::FETCH_NUM) : [];
            $this->query_end(true);
        } catch (\Throwable $ex) {
            $this->lastError = $ex->getMessage();
            $this->query_end(false);
            return $this->tables;
        }

        foreach ($rows as $row) {
            $tablename = reset($row);
            if ($this->prefix !== false && $this->prefix !== '') {
                if (strpos($tablename, $this->prefix) !== 0) {
                    continue;
                }
                $tablename = substr($tablename, strlen($this->prefix));
            }
            $this->tables[$tablename] = $tablename;
        }

        return $this->tables;
    }

    /**
     * Return table indexes.
     *
     * @param string $table
     * @return array
     */
    public function get_indexes($table) {
        $indexes = [];
        $tablename = $this->prefix . $table;

        // Get list of indexes.
        $sql = "PRAGMA index_list('$tablename')";
        $this->query_start($sql, null, SQL_QUERY_AUX_READONLY);
        try {
            $pdo = $this->pdb->getSqlitePdo();
            $statement = $pdo->query($sql);
            $indexlist = $statement ? $statement->fetchAll(\PDO::FETCH_ASSOC) : [];
            $this->query_end(true);
        } catch (\Throwable $ex) {
            $this->lastError = $ex->getMessage();
            $this->query_end(false);
            return $indexes;
        }

        foreach ($indexlist as $indexinfo) {
            $indexname = $indexinfo['name'];

            // Skip auto-created indexes.
            if (strpos($indexname, 'sqlite_autoindex_') === 0) {
                continue;
            }

            // Get columns in this index.
            $sql = "PRAGMA index_info('$indexname')";
            try {
                $pdo = $this->pdb->getSqlitePdo();
                $statement = $pdo->query($sql);
                $columns_info = $statement ? $statement->fetchAll(\PDO::FETCH_ASSOC) : [];
            } catch (\Throwable $ex) {
                continue;
            }

            $columns = [];
            foreach ($columns_info as $col) {
                $columns[] = $col['name'];
            }

            // Skip single-column 'id' indexes (primary key).
            if (count($columns) === 1 && $columns[0] === 'id') {
                continue;
            }

            $indexes[$indexname] = [
                'unique' => !empty($indexinfo['unique']),
                'columns' => $columns,
            ];
        }

        return $indexes;
    }

    /**
     * Returns detailed information about columns in table.
     *
     * @param string $table
     * @return array
     */
    protected function fetch_columns(string $table): array {
        $structure = [];
        $tablename = $this->prefix . $table;

        $sql = "PRAGMA table_info('$tablename')";
        try {
            $pdo = $this->pdb->getSqlitePdo();
            $statement = $pdo->query($sql);
            $rows = $statement ? $statement->fetchAll(\PDO::FETCH_OBJ) : [];
        } catch (\Throwable $ex) {
            return [];
        }

        foreach ($rows as $rawcolumn) {
            $info = new \stdClass();
            $info->name = $rawcolumn->name;
            $sqltype = strtoupper($rawcolumn->type);

            // Parse the SQL type to determine meta_type and attributes.
            if (preg_match('/^(VAR)?CHAR\((\d+)\)/i', $rawcolumn->type, $matches)) {
                $info->type = 'varchar';
                $info->meta_type = 'C';
                $info->max_length = (int)$matches[2];
                $info->scale = null;

            } else if ($sqltype === 'TEXT' || preg_match('/TEXT/i', $sqltype)) {
                $info->type = 'text';
                $info->meta_type = 'X';
                $info->max_length = -1;
                $info->scale = null;

            } else if ($sqltype === 'INTEGER' || preg_match('/INT/i', $sqltype)) {
                $info->type = 'int';
                if ($rawcolumn->pk) {
                    $info->primary_key = true;
                    $info->meta_type = 'R';
                    $info->unique = true;
                    $info->auto_increment = true;
                    $info->has_default = false;
                    $info->max_length = 18;
                } else {
                    $info->primary_key = false;
                    $info->meta_type = 'I';
                    $info->unique = null;
                    $info->auto_increment = false;
                    $info->has_default = ($rawcolumn->dflt_value !== null);
                    // Determine max_length based on type name.
                    if (preg_match('/BIGINT/i', $rawcolumn->type)) {
                        $info->max_length = 18;
                    } else if (preg_match('/SMALLINT/i', $rawcolumn->type)) {
                        $info->max_length = 4;
                    } else if (preg_match('/TINYINT/i', $rawcolumn->type)) {
                        $info->max_length = 2;
                    } else {
                        $info->max_length = 9;
                    }
                }
                $info->scale = null;

            } else if ($sqltype === 'REAL' || preg_match('/FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL/i', $sqltype)) {
                $info->type = 'float';
                $info->meta_type = 'N';
                $info->primary_key = false;
                $info->unique = null;
                $info->auto_increment = false;
                if (preg_match('/\((\d+),(\d+)\)/i', $rawcolumn->type, $matches)) {
                    $info->max_length = (int)$matches[1];
                    $info->scale = (int)$matches[2];
                } else {
                    $info->max_length = 8;
                    $info->scale = 4;
                }

            } else if ($sqltype === 'BLOB' || preg_match('/BLOB|BINARY/i', $sqltype)) {
                $info->type = 'blob';
                $info->meta_type = 'B';
                $info->max_length = -1;
                $info->scale = null;
                $info->primary_key = false;
                $info->binary = true;
                $info->unsigned = null;
                $info->auto_increment = false;
                $info->unique = null;
                $info->not_null = (bool)$rawcolumn->notnull;
                $info->has_default = false;
                $info->default_value = null;
                $structure[$info->name] = new database_column_info($info);
                continue;

            } else {
                // Default to text for unknown types.
                $info->type = 'text';
                $info->meta_type = 'X';
                $info->max_length = -1;
                $info->scale = null;
            }

            // Common attributes for non-blob types.
            if (!isset($info->primary_key)) {
                $info->primary_key = (bool)$rawcolumn->pk;
            }
            if (!isset($info->binary)) {
                $info->binary = false;
            }
            if (!isset($info->unsigned)) {
                $info->unsigned = false;
            }
            if (!isset($info->auto_increment)) {
                $info->auto_increment = (bool)$rawcolumn->pk;
            }
            if (!isset($info->unique)) {
                $info->unique = null;
            }
            $info->not_null = (bool)$rawcolumn->notnull;
            if (!isset($info->has_default)) {
                $info->has_default = ($rawcolumn->dflt_value !== null);
            }
            if (!isset($info->default_value)) {
                if ($info->has_default) {
                    $default = $rawcolumn->dflt_value;
                    // Strip surrounding quotes from default values.
                    if (preg_match("/^'(.*)'$/s", $default, $matches)) {
                        $default = $matches[1];
                    }
                    $info->default_value = $default;
                } else {
                    $info->default_value = null;
                }
            }

            $structure[$info->name] = new database_column_info($info);
        }

        return $structure;
    }

    /**
     * Normalise values based on RDBMS dependencies.
     *
     * @param database_column_info $column
     * @param mixed $value
     * @return mixed
     */
    protected function normalise_value($column, $value) {
        $this->detect_objects($value);

        if (is_bool($value)) {
            return (int)$value;
        }

        if ($value === '' && ($column->meta_type === 'I' || $column->meta_type === 'F' || $column->meta_type === 'N')) {
            return 0;
        }

        return $value;
    }
}
