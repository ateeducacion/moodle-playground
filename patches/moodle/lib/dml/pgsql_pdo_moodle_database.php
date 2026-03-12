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
 * PostgreSQL PDO database class tuned for php-wasm PGlite.
 *
 * @package    core_dml
 * @copyright  2026
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

require_once(__DIR__.'/pdo_moodle_database.php');
require_once(__DIR__.'/moodle_temptables.php');

/**
 * PostgreSQL PDO database class backed by the php-wasm PGlite PDO driver.
 *
 * @package    core_dml
 * @copyright  2026
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class pgsql_pdo_moodle_database extends pdo_moodle_database {
    /**
     * Connect to db.
     *
     * The php-wasm PDO pgsql compatibility layer is backed by PGlite and is a
     * bit more permissive/experimental than native pgsql. In practice, the
     * accepted DSN shape may vary between php-wasm releases, so we try a small
     * set of equivalent PostgreSQL-flavoured DSNs before failing hard.
     *
     * @param string $dbhost
     * @param string $dbuser
     * @param string $dbpass
     * @param string $dbname
     * @param mixed $prefix
     * @param array|null $dboptions
     * @return bool
     */
    public function connect($dbhost, $dbuser, $dbpass, $dbname, $prefix, ?array $dboptions = null) {
        $driverstatus = $this->driver_installed();

        if ($driverstatus !== true) {
            throw new dml_exception('dbdriverproblem', $driverstatus);
        }

        $this->store_settings($dbhost, $dbuser, $dbpass, $dbname, $prefix, $dboptions);

        $errors = [];
        foreach ($this->build_dsn_candidates() as $dsn) {
            try {
                $this->pdb = new \PDO($dsn, $this->dbuser, $this->dbpass, $this->get_pdooptions());
                $this->pdb->setAttribute(\PDO::ATTR_CASE, \PDO::CASE_LOWER);
                $this->pdb->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
                $this->configure_dbconnection();
                $this->temptables = new \moodle_temptables($this);
                return true;
            } catch (\PDOException $ex) {
                $errors[] = $dsn . ' => ' . $ex->getMessage();
            }
        }

        throw new dml_connection_exception(implode("\n", $errors));
    }

    /**
     * Detects if all needed PHP stuff are installed for DB connectivity.
     *
     * @return mixed
     */
    public function driver_installed() {
        if (!class_exists('PDO')) {
            return 'PHP has not been properly configured with PDO support.';
        }

        if (!in_array('pgsql', \PDO::getAvailableDrivers(), true)) {
            return 'PHP has not been properly configured with the PDO PGSQL driver.';
        }

        return true;
    }

    /**
     * Returns database family type.
     *
     * @return string
     */
    public function get_dbfamily() {
        return 'postgres';
    }

    /**
     * Returns more specific database driver type.
     *
     * @return string
     */
    protected function get_dbtype() {
        return 'pgsql';
    }

    /**
     * Returns the driver-dependent DSN for PDO.
     *
     * php-wasm passes the PostgreSQL dbname through to its PGlite-backed PDO
     * implementation and persists it under idb://<dbname>.
     *
     * @return string
     */
    protected function get_dsn() {
        return 'pgsql:dbname=' . $this->dbname;
    }

    /**
     * php-wasm's PGlite-backed PDO bridge does not benefit from persistent
     * connections and some PDO connection attributes trigger unsupported
     * driver paths during install bootstrap.
     *
     * @return array
     */
    protected function get_pdooptions() {
        return [];
    }

    /**
     * Build DSN candidates compatible with php-wasm's PDO/PGlite bridge.
     *
     * @return array
     */
    protected function build_dsn_candidates() {
        $candidates = [];
        $dbname = (string)$this->dbname;
        $dbhost = (string)$this->dbhost;

        if ($dbname !== '') {
            $candidates[] = 'pgsql:dbname=' . $dbname;
            $candidates[] = 'pgsql:' . $dbname;
        }

        if ($dbhost !== '' && $dbname !== '') {
            $candidates[] = 'pgsql:host=' . $dbhost . ';dbname=' . $dbname;
            $candidates[] = 'pgsql:' . $dbhost . '/' . $dbname;
        }

        return array_values(array_unique($candidates));
    }

    /**
     * Apply PostgreSQL LIMIT/OFFSET clauses.
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
     * PostgreSQL LIKE helper.
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

        $operator = $casesensitive
            ? ($notlike ? 'NOT LIKE' : 'LIKE')
            : ($notlike ? 'NOT ILIKE' : 'ILIKE');

        return "$fieldname $operator $param ESCAPE '$escapechar'";
    }

    public function sql_bitxor($int1, $int2) {
        return '((' . $int1 . ') # (' . $int2 . '))';
    }

    public function sql_cast_to_char(string $field): string {
        return "CAST({$field} AS VARCHAR)";
    }

    public function sql_cast_char2int($fieldname, $text = false) {
        return ' CAST(' . $fieldname . ' AS INT) ';
    }

    public function sql_cast_char2real($fieldname, $text = false) {
        return ' ' . $fieldname . '::real ';
    }

    public function sql_concat(...$arr) {
        $sql = implode(' || ', $arr);
        if ($sql === '') {
            return " '' ";
        }
        return " '' || $sql ";
    }

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

    public function sql_group_concat(string $field, string $separator = ', ', string $sort = ''): string {
        $fieldsort = $sort ? "ORDER BY {$sort}" : '';
        return "STRING_AGG(" . $this->sql_cast_to_char($field) . ", '{$separator}' {$fieldsort})";
    }

    public function sql_order_by_null(string $fieldname, int $sort = SORT_ASC): string {
        return parent::sql_order_by_null($fieldname, $sort) . ' NULLS ' . ($sort == SORT_ASC ? 'FIRST' : 'LAST');
    }

    public function sql_regex_supported() {
        return true;
    }

    public function sql_regex($positivematch = true, $casesensitive = false) {
        if ($casesensitive) {
            return $positivematch ? '~' : '!~';
        }

        return $positivematch ? '~*' : '!~*';
    }

    public function replace_all_text_supported() {
        return true;
    }

    public function is_fulltext_search_supported() {
        return true;
    }

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
        $prefix = str_replace('_', '|_', $this->prefix);
        $sql = "SELECT c.relname
                  FROM pg_catalog.pg_class c
                  JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
                 WHERE c.relname LIKE '$prefix%' ESCAPE '|'
                       AND c.relkind = 'r'
                       AND (ns.nspname = current_schema() OR ns.oid = pg_my_temp_schema())";

        $this->query_start($sql, null, SQL_QUERY_AUX_READONLY);
        try {
            $statement = $this->pdb->query($sql);
            $rows = $statement ? $statement->fetchAll(\PDO::FETCH_NUM) : [];
            $this->query_end(true);
        } catch (\PDOException $ex) {
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
        $sql = "SELECT i.*
                  FROM pg_catalog.pg_indexes i
                  JOIN pg_catalog.pg_namespace ns ON ns.nspname = i.schemaname
                 WHERE i.tablename = '$tablename'
                       AND (i.schemaname = current_schema() OR ns.oid = pg_my_temp_schema())";

        $this->query_start($sql, null, SQL_QUERY_AUX_READONLY);
        try {
            $statement = $this->pdb->query($sql);
            $rows = $statement ? $statement->fetchAll(\PDO::FETCH_ASSOC) : [];
            $this->query_end(true);
        } catch (\PDOException $ex) {
            $this->lastError = $ex->getMessage();
            $this->query_end(false);
            return $indexes;
        }

        foreach ($rows as $row) {
            if (!preg_match('/CREATE (|UNIQUE )INDEX ([^\s]+) ON (|' . preg_quote($row['schemaname'], '/') . '\.)' .
                    preg_quote($tablename, '/') . ' USING ([^\s]+) \(([^\)]+)\)/i', $row['indexdef'], $matches)) {
                continue;
            }
            if ($matches[5] === 'id') {
                continue;
            }

            $columns = explode(',', $matches[5]);
            foreach ($columns as $key => $column) {
                $column = trim($column);
                if ($position = strpos($column, ' ')) {
                    $column = substr($column, 0, $position);
                }
                $columns[$key] = $this->trim_quotes($column);
            }

            $indexes[$row['indexname']] = [
                'unique' => !empty($matches[1]),
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
        $sql = "SELECT a.attnum, a.attname AS field, t.typname AS type, a.attlen, a.atttypmod, a.attnotnull, a.atthasdef,
                       CASE WHEN a.atthasdef THEN pg_catalog.pg_get_expr(d.adbin, d.adrelid) ELSE '' END AS adsrc
                  FROM pg_catalog.pg_class c
                  JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
                  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
             LEFT JOIN pg_catalog.pg_attrdef d ON (d.adrelid = c.oid AND d.adnum = a.attnum)
                 WHERE relkind = 'r' AND c.relname = '$tablename' AND c.reltype > 0 AND a.attnum > 0
                       AND (ns.nspname = current_schema() OR ns.oid = pg_my_temp_schema())
              ORDER BY a.attnum";

        $this->query_start($sql, null, SQL_QUERY_AUX_READONLY);
        try {
            $statement = $this->pdb->query($sql);
            $rows = $statement ? $statement->fetchAll(\PDO::FETCH_OBJ) : [];
            $this->query_end(true);
        } catch (\PDOException $ex) {
            $this->lastError = $ex->getMessage();
            $this->query_end(false);
            return [];
        }

        foreach ($rows as $rawcolumn) {
            $info = new \stdClass();
            $info->name = $rawcolumn->field;
            $matches = null;

            if ($rawcolumn->type === 'varchar') {
                $info->type = 'varchar';
                $info->meta_type = 'C';
                $info->max_length = $rawcolumn->atttypmod - 4;
                $info->scale = null;
                $info->not_null = $this->to_bool($rawcolumn->attnotnull);
                $info->has_default = $this->to_bool($rawcolumn->atthasdef);
                if ($info->has_default) {
                    $parts = explode('::', $rawcolumn->adsrc);
                    $info->default_value = count($parts) > 1 ? trim(reset($parts), "'") : $rawcolumn->adsrc;
                } else {
                    $info->default_value = null;
                }
                $info->primary_key = false;
                $info->binary = false;
                $info->unsigned = null;
                $info->auto_increment = false;
                $info->unique = null;

            } else if (preg_match('/int(\d)/i', $rawcolumn->type, $matches)) {
                $info->type = 'int';
                if (strpos($rawcolumn->adsrc ?? '', 'nextval') === 0) {
                    $info->primary_key = true;
                    $info->meta_type = 'R';
                    $info->unique = true;
                    $info->auto_increment = true;
                    $info->has_default = false;
                } else {
                    $info->primary_key = false;
                    $info->meta_type = 'I';
                    $info->unique = null;
                    $info->auto_increment = false;
                    $info->has_default = $this->to_bool($rawcolumn->atthasdef);
                }
                if ($matches[1] >= 8) {
                    $info->max_length = 18;
                } else if ($matches[1] >= 4) {
                    $info->max_length = 9;
                } else if ($matches[1] >= 2) {
                    $info->max_length = 4;
                } else if ($matches[1] >= 1) {
                    $info->max_length = 2;
                } else {
                    $info->max_length = 0;
                }
                $info->scale = null;
                $info->not_null = $this->to_bool($rawcolumn->attnotnull);
                if ($info->has_default) {
                    $parts = explode('::', $rawcolumn->adsrc);
                    $info->default_value = count($parts) > 1 ? reset($parts) : $rawcolumn->adsrc;
                    $info->default_value = trim($info->default_value, "()'");
                } else {
                    $info->default_value = null;
                }
                $info->binary = false;
                $info->unsigned = false;

            } else if ($rawcolumn->type === 'numeric') {
                $info->type = $rawcolumn->type;
                $info->meta_type = 'N';
                $info->primary_key = false;
                $info->binary = false;
                $info->unsigned = null;
                $info->auto_increment = false;
                $info->unique = null;
                $info->not_null = $this->to_bool($rawcolumn->attnotnull);
                $info->has_default = $this->to_bool($rawcolumn->atthasdef);
                if ($info->has_default) {
                    $parts = explode('::', $rawcolumn->adsrc);
                    $info->default_value = count($parts) > 1 ? reset($parts) : $rawcolumn->adsrc;
                    $info->default_value = trim($info->default_value, "()'");
                } else {
                    $info->default_value = null;
                }
                $info->max_length = $rawcolumn->atttypmod >> 16;
                $info->scale = ($rawcolumn->atttypmod & 0xFFFF) - 4;

            } else if (preg_match('/float(\d)/i', $rawcolumn->type, $matches)) {
                $info->type = 'float';
                $info->meta_type = 'N';
                $info->primary_key = false;
                $info->binary = false;
                $info->unsigned = null;
                $info->auto_increment = false;
                $info->unique = null;
                $info->not_null = $this->to_bool($rawcolumn->attnotnull);
                $info->has_default = $this->to_bool($rawcolumn->atthasdef);
                if ($info->has_default) {
                    $parts = explode('::', $rawcolumn->adsrc);
                    $info->default_value = count($parts) > 1 ? reset($parts) : $rawcolumn->adsrc;
                    $info->default_value = trim($info->default_value, "()'");
                } else {
                    $info->default_value = null;
                }
                if ($matches[1] == 8) {
                    $info->max_length = 8;
                    $info->scale = 7;
                } else {
                    $info->max_length = 4;
                    $info->scale = 2;
                }

            } else if ($rawcolumn->type === 'text') {
                $info->type = $rawcolumn->type;
                $info->meta_type = 'X';
                $info->max_length = -1;
                $info->scale = null;
                $info->not_null = $this->to_bool($rawcolumn->attnotnull);
                $info->has_default = $this->to_bool($rawcolumn->atthasdef);
                if ($info->has_default) {
                    $parts = explode('::', $rawcolumn->adsrc);
                    $info->default_value = count($parts) > 1 ? trim(reset($parts), "'") : $rawcolumn->adsrc;
                } else {
                    $info->default_value = null;
                }
                $info->primary_key = false;
                $info->binary = false;
                $info->unsigned = null;
                $info->auto_increment = false;
                $info->unique = null;

            } else if ($rawcolumn->type === 'bytea') {
                $info->type = $rawcolumn->type;
                $info->meta_type = 'B';
                $info->max_length = -1;
                $info->scale = null;
                $info->not_null = $this->to_bool($rawcolumn->attnotnull);
                $info->has_default = false;
                $info->default_value = null;
                $info->primary_key = false;
                $info->binary = true;
                $info->unsigned = null;
                $info->auto_increment = false;
                $info->unique = null;
            } else {
                continue;
            }

            $structure[$info->name] = new database_column_info($info);
        }

        return $structure;
    }

    /**
     * Normalise values based in RDBMS dependencies.
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

        if ($column->meta_type === 'B' && !is_null($value)) {
            return $value;
        }

        if ($value === '' && ($column->meta_type === 'I' || $column->meta_type === 'F' || $column->meta_type === 'N')) {
            return 0;
        }

        return $value;
    }

    /**
     * Helper function trimming (whitespace + quotes) any string.
     *
     * @param string $str
     * @return string
     */
    private function trim_quotes($str) {
        return trim(trim($str), "'\"");
    }

    /**
     * Normalise PostgreSQL truthy values coming back through PDO.
     *
     * @param mixed $value
     * @return bool
     */
    private function to_bool($value) {
        return $value === true || $value === 't' || $value === 'true' || $value === '1' || $value === 1;
    }
}
