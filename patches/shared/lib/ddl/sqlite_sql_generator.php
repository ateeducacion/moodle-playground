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
 * Experimental SQLite specific SQL code generator.
 *
 * @package    core
 * @subpackage ddl
 * @copyright  2008 Andrei Bautu
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

require_once($CFG->libdir . '/ddl/sql_generator.php');

// This class generate SQL code to be used against SQLite.
// It extends XMLDBgenerator so everything can be
// overridden as needed to generate correct SQL.

class sqlite_sql_generator extends sql_generator {

    public $drop_default_value_required = true;
    public $drop_default_value = null;

    public $drop_primary_key = 'ALTER TABLE TABLENAME DROP PRIMARY KEY';
    public $drop_unique_key = 'ALTER TABLE TABLENAME DROP KEY KEYNAME';
    public $drop_foreign_key = 'ALTER TABLE TABLENAME DROP FOREIGN KEY KEYNAME';
    public $default_for_char = '';

    public $sequence_only = true;
    public $sequence_extra_code = false;
    public $sequence_name = 'INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL';
    public $unsigned_allowed = false;

    public $enum_inline_code = true;
    public $enum_extra_code = false;

    public $drop_index_sql = 'ALTER TABLE TABLENAME DROP INDEX INDEXNAME';

    public $rename_index_sql = null;
    public $rename_key_sql = null;

    /**
     * Creates one new SQLite SQL generator.
     * @param moodle_database $mdb
     * @param moodle_temptables|null $temptables
     */
    public function __construct($mdb, $temptables = null) {
        parent::__construct($mdb, $temptables);
    }

    /**
     * Reset a sequence to the id field of a table.
     * @param string|xmldb_table $table
     * @return array
     */
    public function getResetSequenceSQL($table) {
        if ($table instanceof xmldb_table) {
            $table = $table->getName();
        }

        $value = (int)$this->mdb->get_field_sql('SELECT MAX(id) FROM {' . $table . '}');
        return array("UPDATE sqlite_sequence SET seq=$value WHERE name='{$this->prefix}{$table}'");
    }

    /**
     * Given one correct xmldb_table, returns the SQL statements to create a temporary table.
     * @param xmldb_table $xmldb_table
     * @return array
     */
    public function getCreateTempTableSQL($xmldb_table) {
        $this->temptables->add_temptable($xmldb_table->getName());
        $sqlarr = $this->getCreateTableSQL($xmldb_table);
        $sqlarr = preg_replace('/^CREATE TABLE/', 'CREATE TEMPORARY TABLE', $sqlarr);
        return $sqlarr;
    }

    /**
     * Given one correct xmldb_key, returns its specs.
     * @param xmldb_table $xmldb_table
     * @param xmldb_key $xmldb_key
     * @return string
     */
    public function getKeySQL($xmldb_table, $xmldb_key) {
        $key = '';

        switch ($xmldb_key->getType()) {
            case XMLDB_KEY_PRIMARY:
                if ($this->primary_keys && count($xmldb_key->getFields()) > 1) {
                    if ($this->primary_key_name !== null) {
                        $key = $this->getEncQuoted($this->primary_key_name);
                    } else {
                        $key = $this->getNameForObject($xmldb_table->getName(), implode(', ', $xmldb_key->getFields()), 'pk');
                    }
                    $key .= ' PRIMARY KEY (' . implode(', ', $this->getEncQuoted($xmldb_key->getFields())) . ')';
                }
                break;
            case XMLDB_KEY_UNIQUE:
                if ($this->unique_keys) {
                    $key = $this->getNameForObject($xmldb_table->getName(), implode(', ', $xmldb_key->getFields()), 'uk');
                    $key .= ' UNIQUE (' . implode(', ', $this->getEncQuoted($xmldb_key->getFields())) . ')';
                }
                break;
            case XMLDB_KEY_FOREIGN:
            case XMLDB_KEY_FOREIGN_UNIQUE:
                if ($this->foreign_keys) {
                    $key = $this->getNameForObject($xmldb_table->getName(), implode(', ', $xmldb_key->getFields()), 'fk');
                    $key .= ' FOREIGN KEY (' . implode(', ', $this->getEncQuoted($xmldb_key->getFields())) . ')';
                    $key .= ' REFERENCES ' . $this->getEncQuoted($this->prefix . $xmldb_key->getRefTable());
                    $key .= ' (' . implode(', ', $this->getEncQuoted($xmldb_key->getRefFields())) . ')';
                }
                break;
        }

        return $key;
    }

    /**
     * Given one XMLDB Type, length and decimals, returns the DB proper SQL type.
     * @param int $xmldb_type
     * @param int|null $xmldb_length
     * @param int|null $xmldb_decimals
     * @return string
     */
    public function getTypeSQL($xmldb_type, $xmldb_length = null, $xmldb_decimals = null) {
        switch ($xmldb_type) {
            case XMLDB_TYPE_INTEGER:
                if (empty($xmldb_length)) {
                    $xmldb_length = 10;
                }
                $dbtype = 'INTEGER(' . $xmldb_length . ')';
                break;
            case XMLDB_TYPE_NUMBER:
                $dbtype = $this->number_type;
                if (!empty($xmldb_length)) {
                    $dbtype .= '(' . $xmldb_length;
                    if (!empty($xmldb_decimals)) {
                        $dbtype .= ',' . $xmldb_decimals;
                    }
                    $dbtype .= ')';
                }
                break;
            case XMLDB_TYPE_FLOAT:
                $dbtype = 'REAL';
                if (!empty($xmldb_length)) {
                    $dbtype .= '(' . $xmldb_length;
                    if (!empty($xmldb_decimals)) {
                        $dbtype .= ',' . $xmldb_decimals;
                    }
                    $dbtype .= ')';
                }
                break;
            case XMLDB_TYPE_CHAR:
                $dbtype = 'VARCHAR';
                if (empty($xmldb_length)) {
                    $xmldb_length = '255';
                }
                $dbtype .= '(' . $xmldb_length . ')';
                break;
            case XMLDB_TYPE_BINARY:
                $dbtype = 'BLOB';
                break;
            case XMLDB_TYPE_DATETIME:
                $dbtype = 'DATETIME';
                break;
            case XMLDB_TYPE_TEXT:
            default:
                $dbtype = 'TEXT';
                break;
        }
        return $dbtype;
    }

    /**
     * Function to emulate full ALTER TABLE which SQLite does not support.
     * @param xmldb_table $xmldb_table
     * @param xmldb_field|null $xmldb_add_field
     * @param xmldb_field|null $xmldb_delete_field
     * @return array
     */
    protected function getAlterTableSchema($xmldb_table, $xmldb_add_field = null, $xmldb_delete_field = null) {
        $tablename = $this->getTableName($xmldb_table);

        $oldname = $xmldb_delete_field ? $xmldb_delete_field->getName() : null;
        $newname = $xmldb_add_field ? $xmldb_add_field->getName() : null;
        if ($xmldb_delete_field) {
            $xmldb_table->deleteField($oldname);
        }
        if ($xmldb_add_field) {
            $xmldb_table->addField($xmldb_add_field);
        }
        if ($oldname) {
            $indexes = $xmldb_table->getIndexes();
            foreach ($indexes as $index) {
                $fields = $index->getFields();
                $i = array_search($oldname, $fields);
                if ($i !== false) {
                    if ($newname) {
                        $fields[$i] = $newname;
                    } else {
                        unset($fields[$i]);
                    }
                    $xmldb_table->deleteIndex($index->getName());
                    if (count($fields)) {
                        $index->setFields($fields);
                        $xmldb_table->addIndex($index);
                    }
                }
            }
            $keys = $xmldb_table->getKeys();
            foreach ($keys as $key) {
                $fields = $key->getFields();
                $reffields = $key->getRefFields();
                $i = array_search($oldname, $fields);
                if ($i !== false) {
                    if ($newname) {
                        $fields[$i] = $newname;
                    } else {
                        unset($fields[$i]);
                        unset($reffields[$i]);
                    }
                    $xmldb_table->deleteKey($key->getName());
                    if (count($fields)) {
                        $key->setFields($fields);
                        $key->setRefFields($fields);
                        $xmldb_table->addkey($key);
                    }
                }
            }
        }

        $fields = $xmldb_table->getFields();
        foreach ($fields as $key => $field) {
            $fieldname = $field->getName();
            if ($fieldname == $newname && $oldname && $oldname != $newname) {
                $fields[$key] = $this->getEncQuoted($oldname) . ' AS ' . $this->getEncQuoted($newname);
            } else {
                $fields[$key] = $this->getEncQuoted($field->getName());
            }
        }
        $fields = implode(',', $fields);
        $results[] = 'BEGIN TRANSACTION';
        $results[] = 'CREATE TEMPORARY TABLE temp_data AS SELECT * FROM ' . $tablename;
        $results[] = 'DROP TABLE ' . $tablename;
        $results = array_merge($results, $this->getCreateTableSQL($xmldb_table));
        $results[] = 'INSERT INTO ' . $tablename . ' SELECT ' . $fields . ' FROM temp_data';
        $results[] = 'DROP TABLE temp_data';
        $results[] = 'COMMIT';
        return $results;
    }

    public function getAlterFieldSQL($xmldb_table, $xmldb_field, $skip_type_clause = null, $skip_default_clause = null, $skip_notnull_clause = null) {
        return $this->getAlterTableSchema($xmldb_table, $xmldb_field, $xmldb_field);
    }

    public function getAddKeySQL($xmldb_table, $xmldb_key) {
        $xmldb_table->addKey($xmldb_key);
        return $this->getAlterTableSchema($xmldb_table);
    }

    public function getCreateEnumSQL($xmldb_table, $xmldb_field) {
        return $this->getAlterTableSchema($xmldb_table, $xmldb_field, $xmldb_field);
    }

    public function getDropEnumSQL($xmldb_table, $xmldb_field) {
        return $this->getAlterTableSchema($xmldb_table, $xmldb_field, $xmldb_field);
    }

    public function getCreateDefaultSQL($xmldb_table, $xmldb_field) {
        return $this->getAlterTableSchema($xmldb_table, $xmldb_field, $xmldb_field);
    }

    public function getRenameFieldSQL($xmldb_table, $xmldb_field, $newname) {
        $oldfield = clone($xmldb_field);
        $xmldb_field->setName($newname);
        return $this->getAlterTableSchema($xmldb_table, $xmldb_field, $oldfield);
    }

    public function getRenameTableSQL($xmldb_table, $newname) {
        $oldtablename = $this->getTableName($xmldb_table);
        $xmldb_table->setName($newname);
        $newtablename = $this->getTableName($xmldb_table);

        return array('ALTER TABLE ' . $oldtablename . ' RENAME TO ' . $newtablename);
    }

    public function getDropTableSQL($xmldb_table) {
        return array('DROP TABLE ' . $this->getTableName($xmldb_table));
    }

    public function getAddFieldSQL($xmldb_table, $xmldb_field, $skip_type_clause = null, $skip_default_clause = null, $skip_notnull_clause = null) {
        return $this->getAlterTableSchema($xmldb_table, $xmldb_field);
    }

    public function getAddIndexSQL($xmldb_table, $xmldb_index) {
        $xmldb_table->addIndex($xmldb_index);
        return $this->getAlterTableSchema($xmldb_table);
    }

    public function getRenameIndexSQL($xmldb_table, $xmldb_index, $newname) {
        $dbindexname = $this->mdb->get_manager()->find_index_name($xmldb_table, $xmldb_index);
        $xmldb_index->setName($newname);
        $results = array('DROP INDEX ' . $dbindexname);
        $results = array_merge($results, $this->getCreateIndexSQL($xmldb_table, $xmldb_index));
        return $results;
    }

    public function getRenameKeySQL($xmldb_table, $xmldb_key, $newname) {
        $xmldb_table->deleteKey($xmldb_key->getName());
        $xmldb_key->setName($newname);
        $xmldb_table->addkey($xmldb_key);
        return $this->getAlterTableSchema($xmldb_table);
    }

    public function getDropFieldSQL($xmldb_table, $xmldb_field) {
        return $this->getAlterTableSchema($xmldb_table, null, $xmldb_field);
    }

    public function getDropIndexSQL($xmldb_table, $xmldb_index) {
        $xmldb_table->deleteIndex($xmldb_index->getName());
        return $this->getAlterTableSchema($xmldb_table);
    }

    public function getDropKeySQL($xmldb_table, $xmldb_key) {
        $xmldb_table->deleteKey($xmldb_key->getName());
        return $this->getAlterTableSchema($xmldb_table);
    }

    public function getDropDefaultSQL($xmldb_table, $xmldb_field) {
        return $this->getAlterTableSchema($xmldb_table, $xmldb_field, $xmldb_field);
    }

    public function getCommentSQL($xmldb_table) {
        return array();
    }

    /**
     * Given one xmldb_table returns one array with all the check constraints.
     * @param xmldb_table $xmldb_table
     * @param xmldb_field|null $xmldb_field
     * @return array
     */
    public function getCheckConstraintsFromDB($xmldb_table, $xmldb_field = null) {
        $tablename = $xmldb_table->getName($xmldb_table);
        if (!$columns = $this->mdb->get_columns($tablename, false)) {
            return array();
        }
        $results = array();
        $filter = $xmldb_field ? $xmldb_field->getName() : null;
        foreach ($columns as $key => $column) {
            if (!empty($column->enums) && (!$filter || $column->name == $filter)) {
                $result = new stdClass();
                $result->name = $key;
                $result->description = implode(', ', $column->enums);
                $results[$key] = $result;
            }
        }
        return $results;
    }

    public function isNameInUse($object_name, $type, $table_name) {
        return false;
    }

    public static function getReservedWords() {
        return array(
            'add', 'all', 'alter', 'and', 'as', 'autoincrement',
            'between', 'by',
            'case', 'check', 'collate', 'column', 'commit', 'constraint', 'create', 'cross',
            'default', 'deferrable', 'delete', 'distinct', 'drop',
            'else', 'escape', 'except', 'exists',
            'foreign', 'from', 'full',
            'group',
            'having',
            'in', 'index', 'inner', 'insert', 'intersect', 'into', 'is', 'isnull',
            'join',
            'left', 'limit',
            'natural', 'not', 'notnull', 'null',
            'on', 'or', 'order', 'outer',
            'primary',
            'references', 'regexp', 'right', 'rollback',
            'select', 'set',
            'table', 'then', 'to', 'transaction',
            'union', 'unique', 'update', 'using',
            'values',
            'when', 'where',
        );
    }

    public function addslashes($s) {
        return str_replace("'", "''", $s);
    }
}
