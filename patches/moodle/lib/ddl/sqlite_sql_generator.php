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

        // SQLite cannot ALTER a table in place, so we rebuild it: copy the live
        // table into temp_data (SELECT *), drop it, recreate it from the desired
        // schema, then copy the data back. Both halves of this need the real
        // current column set, because add_field()/add_key()/etc. are routinely
        // called with an xmldb_table that only carries the table name (and at
        // most the single field being changed) — see database_manager::add_field
        // which documents "just the name is mandatory". Trusting
        // $xmldb_table->getFields() alone would recreate the table with only that
        // one column and silently drop every existing column.
        $livecolumns = $this->mdb->get_columns($xmldb_table->getName(), false);
        $existingcolumns = array();
        if ($livecolumns) {
            foreach ($livecolumns as $livecolumn) {
                $existingcolumns[strtolower($livecolumn->name)] = $livecolumn;
            }
        }

        // Re-declare every surviving live column (in its original order) that the
        // caller did not describe, so getCreateTableSQL() recreates them instead
        // of dropping them. Skip the field being dropped, and the old name of a
        // rename (its data is moved to $newname, which the caller adds below).
        // While iterating, capture the live primary-key columns (in declaration
        // order) so the constraint can be rebuilt below — without it
        // getCreateTableSQL() either throws ddsequenceerror for the autoincrement
        // 'id' column or silently drops a composite primary key.
        $pkcolumns = array();
        foreach ($existingcolumns as $columnname => $livecolumn) {
            if (!empty($livecolumn->primary_key)) {
                if ($oldname && $columnname === strtolower($oldname)) {
                    // The primary-key column is the field being dropped or renamed.
                    // A drop removes it from the key; a rename moves it to $newname.
                    if ($newname) {
                        $pkcolumns[] = $newname;
                    }
                } else {
                    $pkcolumns[] = $livecolumn->name;
                }
            }
            if ($oldname && $columnname === strtolower($oldname)) {
                continue;
            }
            if ($xmldb_table->getField($livecolumn->name)) {
                continue; // Already described by the caller's table object.
            }
            $xmldb_table->addField($this->column_info_to_xmldb_field($livecolumn));
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

        // The caller's xmldb_table usually carries no keys (add_field()/etc. are
        // documented to need "just the name"). Re-add the live primary key unless
        // the caller already described one, otherwise getCreateTableSQL() throws
        // ddsequenceerror for the autoincrement 'id' and any composite primary key
        // would be silently dropped.
        $hasprimary = false;
        foreach ($xmldb_table->getKeys() as $existingkey) {
            if ($existingkey->getType() == XMLDB_KEY_PRIMARY) {
                $hasprimary = true;
                break;
            }
        }
        if (!$hasprimary && count($pkcolumns)) {
            $xmldb_table->addKey(new xmldb_key('primary', XMLDB_KEY_PRIMARY, $pkcolumns));
        }

        // Build the data-copy SELECT list. It must reference ONLY columns that
        // physically exist in temp_data (the pre-change table). Columns in the
        // recreated schema that are absent from temp_data (genuinely new fields)
        // are populated with NULL so SQLite applies their column default.
        $fields = $xmldb_table->getFields();
        foreach ($fields as $key => $field) {
            $fieldname = $field->getName();
            if ($fieldname == $newname && $oldname && $oldname != $newname) {
                // Renamed field: the data still lives under the old column name
                // in temp_data, so copy it across to the new name.
                $fields[$key] = $this->getEncQuoted($oldname) . ' AS ' . $this->getEncQuoted($newname);
            } else if (!isset($existingcolumns[strtolower($fieldname)])) {
                // Brand-new column not present in temp_data: select NULL so the
                // recreated table falls back to the column default for this field.
                $fields[$key] = 'NULL AS ' . $this->getEncQuoted($fieldname);
            } else {
                $fields[$key] = $this->getEncQuoted($fieldname);
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

    /**
     * Build an xmldb_field describing an existing live column, so it can be
     * re-declared when SQLite rebuilds a table for an ALTER emulation.
     *
     * The mapping is driven by the canonical meta_type that
     * sqlite3_pdo_moodle_database::get_columns() assigns, which is more reliable
     * than the raw SQLite type affinity string.
     *
     * @param database_column_info $column
     * @return xmldb_field
     */
    protected function column_info_to_xmldb_field($column) {
        $field = new xmldb_field($column->name);

        switch ($column->meta_type) {
            case 'N': // Number / decimal.
                $type = XMLDB_TYPE_NUMBER;
                break;
            case 'C': // Char / varchar.
                $type = XMLDB_TYPE_CHAR;
                break;
            case 'X': // Text.
                $type = XMLDB_TYPE_TEXT;
                break;
            case 'B': // Binary / blob.
                $type = XMLDB_TYPE_BINARY;
                break;
            case 'R': // Auto-increment counter.
            case 'I': // Integer.
            case 'L': // Boolean stored as integer.
            case 'T': // Timestamp stored as integer.
            case 'D': // Date stored as integer.
            default:
                $type = XMLDB_TYPE_INTEGER;
                break;
        }

        $field->setType($type);

        if ($type !== XMLDB_TYPE_TEXT && $type !== XMLDB_TYPE_BINARY) {
            if (!empty($column->max_length)) {
                $field->setLength($column->max_length);
            }
            if ($type === XMLDB_TYPE_NUMBER && !empty($column->scale)) {
                $field->setDecimals($column->scale);
            }
        }

        $field->setNotNull(!empty($column->not_null));

        if (!empty($column->has_default)) {
            $field->setDefault($column->default_value);
        }

        if (!empty($column->auto_increment) || $column->meta_type === 'R') {
            $field->setSequence(true);
        }

        return $field;
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
