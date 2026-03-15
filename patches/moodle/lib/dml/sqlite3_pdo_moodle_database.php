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
 * Experimental pdo database class.
 *
 * @package    core_dml
 * @copyright  2008 Andrei Bautu
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

require_once(__DIR__ . '/pdo_moodle_database.php');
require_once(__DIR__ . '/moodle_temptables.php');

/**
 * Experimental pdo database class
 *
 * @package    core_dml
 * @copyright  2008 Andrei Bautu
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class sqlite3_pdo_moodle_database extends pdo_moodle_database {
    protected $database_file_extension = '.sq3.php';

    /**
     * Connect to db and initialise temp table tracking required by current Moodle core.
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
        $result = parent::connect($dbhost, $dbuser, $dbpass, $dbname, $prefix, $dboptions);
        $this->temptables = new moodle_temptables($this);
        return $result;
    }

    /**
     * Detects if all needed PHP stuff installed.
     * Note: can be used before connect()
     * @return mixed true if ok, string if something
     */
    public function driver_installed() {
        if (!extension_loaded('pdo_sqlite') || !extension_loaded('pdo')) {
            return get_string('sqliteextensionisnotpresentinphp', 'install');
        }
        return true;
    }

    /**
     * Returns database family type.
     * Note: can be used before connect()
     * @return string
     */
    public function get_dbfamily() {
        return 'sqlite';
    }

    /**
     * Returns more specific database driver type.
     * Note: can be used before connect()
     * @return string
     */
    protected function get_dbtype() {
        return 'sqlite3';
    }

    /**
     * Avoid PDO connection options that are tuned for client/server drivers.
     * @return array
     */
    protected function get_pdooptions() {
        return [];
    }

    protected function configure_dbconnection() {
        // Try to protect database file against web access when moodledata is web accessible.
        $this->pdb->exec('CREATE TABLE IF NOT EXISTS "<?php die?>" (id int)');
        $this->pdb->exec('PRAGMA synchronous=OFF');
        $this->pdb->exec('PRAGMA short_column_names=1');
        $this->pdb->exec('PRAGMA encoding="UTF-8"');
        $this->pdb->exec('PRAGMA case_sensitive_like=0');
        $this->pdb->exec('PRAGMA locking_mode=NORMAL');
    }

    /**
     * Attempt to create the database.
     * @param string $dbhost
     * @param string $dbuser
     * @param string $dbpass
     * @param string $dbname
     * @param array|null $dboptions
     * @return bool
     */
    public function create_database($dbhost, $dbuser, $dbpass, $dbname, ?array $dboptions = null) {
        global $CFG;

        $this->dbhost = $dbhost;
        $this->dbuser = $dbuser;
        $this->dbpass = $dbpass;
        $this->dbname = $dbname;
        $this->dboptions = $dboptions;

        $filepath = $this->get_dbfilepath();
        $dirpath = dirname($filepath);
        @mkdir($dirpath, $CFG->directorypermissions, true);
        return touch($filepath);
    }

    /**
     * Returns the driver-dependent DSN for PDO based on members stored by connect.
     * @return string
     */
    protected function get_dsn() {
        return 'sqlite:' . $this->get_dbfilepath();
    }

    /**
     * Returns the file path for the database file.
     * @return string
     */
    public function get_dbfilepath() {
        global $CFG;

        if (!empty($this->dboptions['file'])) {
            return $this->dboptions['file'];
        }
        if ($this->dbhost && $this->dbhost != 'localhost') {
            $path = $this->dbhost;
        } else {
            $path = $CFG->dataroot;
        }
        $path = rtrim($path, '\\/') . '/';
        if (!empty($this->dbuser)) {
            $path .= $this->dbuser . '_';
        }
        $path .= $this->dbname . '_' . md5($this->dbpass) . $this->database_file_extension;
        return $path;
    }

    /**
     * Returns the database server info.
     * @return array An array with 'description' and 'version' keys.
     */
    public function get_server_info(): array {
        $version = '';
        try {
            $version = $this->pdb->getAttribute(\PDO::ATTR_SERVER_VERSION);
        } catch (\Exception $e) {
            $version = '3.0.0';
        }
        return [
            'description' => 'SQLite ' . $version,
            'version' => $version,
        ];
    }

    /**
     * Return tables in database without current prefix.
     * @param bool $usecache
     * @return array
     */
    public function get_tables($usecache = true) {
        $tables = array();

        $sql = 'SELECT name FROM sqlite_master WHERE type="table" UNION ALL SELECT name FROM sqlite_temp_master WHERE type="table" ORDER BY name';
        if ($this->debug) {
            $this->debug_query($sql);
        }
        $rstables = $this->pdb->query($sql);
        foreach ($rstables as $table) {
            $table = strtolower($table['name']);
            if ($this->prefix !== false && $this->prefix !== '') {
                if (strpos($table, $this->prefix) !== 0) {
                    continue;
                }
                $table = substr($table, strlen($this->prefix));
            }
            $tables[$table] = $table;
        }
        return $tables;
    }

    /**
     * Return table indexes.
     * @param string $table
     * @return array
     */
    public function get_indexes($table) {
        $indexes = array();
        $sql = 'PRAGMA index_list(' . $this->prefix . $table . ')';
        if ($this->debug) {
            $this->debug_query($sql);
        }
        $rsindexes = $this->pdb->query($sql);
        foreach ($rsindexes as $index) {
            $unique = (bool)$index['unique'];
            $index = $index['name'];
            $sql = 'PRAGMA index_info("' . $index . '")';
            if ($this->debug) {
                $this->debug_query($sql);
            }
            $rscolumns = $this->pdb->query($sql);
            $columns = array();
            foreach ($rscolumns as $row) {
                $columns[] = strtolower($row['name']);
            }
            $index = strtolower($index);
            $indexes[$index]['unique'] = $unique;
            $indexes[$index]['columns'] = $columns;
        }
        return $indexes;
    }

    /**
     * Select rows and return first-column values as an array.
     * Current Moodle core expects an empty array, not false, when no rows exist.
     *
     * @param string $sql
     * @param array|null $params
     * @return array|false
     */
    public function get_fieldset_sql($sql, ?array $params = null) {
        $rs = $this->get_recordset_sql($sql, $params);
        if ($rs === false) {
            return false;
        }
        if (!$rs->valid()) {
            $rs->close();
            return [];
        }
        $result = array();
        foreach ($rs as $value) {
            $arr = (array)$value;
            $result[] = reset($arr);
        }
        $rs->close();
        return $result;
    }

    /**
     * Return records indexed by the first selected column.
     * Current Moodle core expects an empty array, not false, when no rows exist.
     *
     * @param string $sql
     * @param array|null $params
     * @param int $limitfrom
     * @param int $limitnum
     * @return array|false
     */
    public function get_records_sql($sql, ?array $params = null, $limitfrom = 0, $limitnum = 0) {
        global $CFG;

        $rs = $this->get_recordset_sql($sql, $params, $limitfrom, $limitnum);
        if ($rs === false) {
            return false;
        }
        if (!$rs->valid()) {
            $rs->close();
            return [];
        }
        $objects = array();
        foreach ($rs as $value) {
            $row = (array)$value;
            $key = reset($row);
            if ($CFG->debugdeveloper && array_key_exists($key, $objects)) {
                debugging("Did you remember to make the first column something unique in your call to get_records? Duplicate value '$key' found in column first column of '$sql'.", DEBUG_DEVELOPER);
            }
            $objects[$key] = (object)$row;
        }
        $rs->close();
        return $objects;
    }

    /**
     * Returns detailed information about columns in table.
     * @param string $table
     * @return array
     */
    protected function fetch_columns(string $table): array {
        $structure = array();

        $sql = 'SELECT sql FROM sqlite_master WHERE type="table" AND tbl_name="' . $this->prefix . $table . '"';
        if ($this->debug) {
            $this->debug_query($sql);
        }
        $createsql = $this->pdb->query($sql)->fetch();
        if (!$createsql) {
            return [];
        }
        $createsql = $createsql['sql'];

        $sql = 'PRAGMA table_info("' . $this->prefix . $table . '")';
        if ($this->debug) {
            $this->debug_query($sql);
        }
        $rscolumns = $this->pdb->query($sql);
        foreach ($rscolumns as $row) {
            $columninfo = array(
                'name' => strtolower($row['name']),
                'not_null' => (bool)$row['notnull'],
                'primary_key' => (bool)$row['pk'],
                'has_default' => !is_null($row['dflt_value']),
                'default_value' => $row['dflt_value'],
                'auto_increment' => false,
                'binary' => false,
            );
            $type = explode('(', $row['type']);
            $columninfo['type'] = strtolower($type[0]);
            if (count($type) > 1) {
                $size = explode(',', trim($type[1], ')'));
                $columninfo['max_length'] = $size[0];
                if (count($size) > 1) {
                    $columninfo['scale'] = $size[1];
                }
            }
            switch (substr($columninfo['type'], 0, 3)) {
                case 'int':
                    if ($columninfo['primary_key'] && preg_match('/' . $columninfo['name'] . '\W+integer\W+primary\W+key\W+autoincrement/im', $createsql)) {
                        $columninfo['meta_type'] = 'R';
                        $columninfo['auto_increment'] = true;
                    } else {
                        $columninfo['meta_type'] = 'I';
                    }
                    break;
                case 'num':
                case 'rea':
                case 'dou':
                case 'flo':
                    $columninfo['meta_type'] = 'N';
                    break;
                case 'var':
                case 'cha':
                case 'enu':
                    $columninfo['meta_type'] = 'C';
                    break;
                case 'tex':
                case 'clo':
                    $columninfo['meta_type'] = 'X';
                    break;
                case 'blo':
                case 'non':
                    $columninfo['meta_type'] = 'B';
                    $columninfo['binary'] = true;
                    break;
                case 'boo':
                case 'bit':
                case 'log':
                    $columninfo['meta_type'] = 'L';
                    $columninfo['max_length'] = 1;
                    break;
                case 'tim':
                    $columninfo['meta_type'] = 'T';
                    break;
                case 'dat':
                    $columninfo['meta_type'] = 'D';
                    break;
            }
            if ($columninfo['has_default'] && ($columninfo['meta_type'] == 'X' || $columninfo['meta_type'] == 'C')) {
                $columninfo['default_value'] = substr($columninfo['default_value'], 1, -1);
            }
            $structure[$columninfo['name']] = new database_column_info($columninfo);
        }

        return $structure;
    }

    /**
     * Normalise values based in RDBMS dependencies.
     * @param database_column_info $column
     * @param mixed $value
     * @return mixed
     */
    protected function normalise_value($column, $value) {
        return $value;
    }

    /**
     * Returns the sql statement with clauses to append used to limit a recordset range.
     * @param string $sql
     * @param int $limitfrom
     * @param int $limitnum
     * @return string
     */
    protected function get_limit_clauses($sql, $limitfrom = 0, $limitnum = 0) {
        if ($limitnum) {
            $sql .= ' LIMIT ' . $limitnum;
            if ($limitfrom) {
                $sql .= ' OFFSET ' . $limitfrom;
            }
        }
        return $sql;
    }

    /**
     * Delete the records from a table where all the given conditions met.
     * @param string $table
     * @param array|null $conditions
     * @return bool
     */
    public function delete_records($table, ?array $conditions = null) {
        if (is_null($conditions)) {
            return $this->execute("DELETE FROM {{$table}}");
        }
        list($select, $params) = $this->where_clause($table, $conditions);
        return $this->delete_records_select($table, $select, $params);
    }

    /**
     * Returns the proper SQL to do CONCAT between the elements passed.
     * @param string ...$elements
     * @return string
     */
    public function sql_concat(...$elements) {
        return implode('||', $elements);
    }

    /**
     * Returns the proper SQL to do CONCAT between the elements passed with a separator.
     * @param string $separator
     * @param array $elements
     * @return string
     */
    public function sql_concat_join($separator = "' '", $elements = array()) {
        for ($n = count($elements) - 1; $n > 0; $n--) {
            array_splice($elements, $n, 0, $separator);
        }
        return implode('||', $elements);
    }

    /**
     * Returns the SQL text to be used in order to perform one bitwise XOR operation between 2 integers.
     * @param int $int1
     * @param int $int2
     * @return string
     */
    public function sql_bitxor($int1, $int2) {
        return '( ~' . $this->sql_bitand($int1, $int2) . ' & ' . $this->sql_bitor($int1, $int2) . ')';
    }
}
