# Migración PGlite → SQLite vía sqlite-database-integration AST Driver

## Resumen

Se reemplazó **PGlite** (PostgreSQL compilado a WASM, ~14MB) con **SQLite** (integrado nativamente en PHP WASM) como backend de base de datos del Moodle Playground. La traducción de MySQL SQL → SQLite SQL se realiza en tiempo de ejecución mediante el motor AST de [WordPress sqlite-database-integration](https://github.com/WordPress/sqlite-database-integration) v2.2.18.

## Arquitectura

```
Moodle DML (genera MySQL SQL via XMLDB + mysql_sql_generator)
    │
    ▼
sqlite_pdo_moodle_database (driver custom, extiende pdo_moodle_database)
    │  get_dbfamily() → 'mysql'  (XMLDB genera DDL MySQL)
    │  get_dbtype() → 'sqlite'
    │
    ▼
sqlite_translating_pdo (wrapper PHP, envuelve WP_PDO_MySQL_On_SQLite)
    │  Intercepta prepare()/query()/exec()
    │  Traduce MySQL → SQLite via AST
    │
    ▼
WP_PDO_MySQL_On_SQLite (motor AST de WordPress)
    │  MySQLLexer → MySQLParser → SQLite rewriter
    │
    ▼
PDO SQLite real ('/persist/<dbname>.db')
    │
    ▼
Emscripten VFS → IDBFS (persistencia en IndexedDB)
```

## Archivos creados

| Archivo | Descripción |
|---------|-------------|
| `patches/moodle/lib/dml/sqlite_pdo_moodle_database.php` | Driver DML de Moodle para SQLite. Extiende `pdo_moodle_database`, retorna `get_dbfamily()='mysql'` para que XMLDB genere DDL MySQL, implementa introspección de tablas/columnas/índices via PRAGMAs de SQLite |
| `patches/moodle/lib/dml/sqlite_translating_pdo.php` | Wrapper PDO que envuelve `WP_PDO_MySQL_On_SQLite`. Incluye `sqlite_translating_statement` para soporte de `prepare()` con sustitución de parámetros |
| `patches/moodle/lib/dml/sqlite-ast-driver/` | Librería vendorizada de WordPress sqlite-database-integration v2.2.18 (lexer MySQL, parser, driver SQLite AST) |
| `patches/moodle/lib/dml/sqlite-ast-driver/load.php` | Autoloader que carga todas las clases del AST driver en el orden correcto |

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `src/runtime/php-loader.js` | Eliminada clase `PGliteCompat` (~105 líneas), `flushAllPGliteInstances()`, import de PGlite. `buildSharedRuntimeOptions()` simplificado a solo `{ sharedLibs }` |
| `src/runtime/config-template.js` | `dbtype='pgsql'` → `'sqlite'`, `dblibrary='pdo'`, eliminada `dbcollation`, `dbname` usa ruta de archivo SQLite |
| `src/runtime/bootstrap.js` | `flushDatabasePersistence` → `syncFilesystem` (no-op), probes PDO actualizados a DSN `sqlite:`, probe DDL usa DDL SQLite |
| `lib/constants.js` | Eliminada `PGLITE_MODULE_URL`, `DEFAULT_BOOT_OPTIONS` con credenciales vacías |
| `lib/config-template.js` | Mismos cambios de dbtype/dblibrary |
| `lib/php-runtime.js` | Eliminados import/export de PGlite, probe actualizado |
| `src/remote/main.js` | Eliminados patrones IndexedDB específicos de PGlite (`idb://`, `/pglite/`) |
| `scripts/sync-browser-deps.mjs` | Eliminada copia de vendor PGlite |
| `scripts/patch-moodle-source.sh` | Copia driver SQLite + paquetes AST en vez de driver PGlite; lang strings de `pdopgsql` a `pdosqlite` |
| `package.json` | Eliminada dependencia `@electric-sql/pglite` |

## Archivos eliminados

| Archivo | Descripción |
|---------|-------------|
| `patches/moodle/lib/dml/pgsql_pdo_moodle_database.php` | Driver PGlite antiguo (597 líneas) |
| `vendor/pglite/` | ~200+ archivos de vendor PGlite (~14MB: WASM, data, extensiones PostgreSQL) |

## Decisiones técnicas

1. **`get_dbfamily() = 'mysql'`**: Moodle genera DDL MySQL que el traductor AST convierte a SQLite. Esto evita tener que escribir un `sqlite_sql_generator` completo para XMLDB.

2. **`sqlite_translating_pdo` como wrapper**: `WP_PDO_MySQL_On_SQLite` extiende PDO pero no implementa `prepare()`. El wrapper añade soporte de `prepare()` con sustitución de parámetros para compatibilidad con `pdo_moodle_database`.

3. **Vendorizado directo**: La librería WordPress se incluye directamente en `patches/` (v2.2.18), versionada y reproducible.

4. **Persistencia**: La base de datos SQLite se almacena en `/persist/<dbname>.db`, persistida automáticamente via IDBFS de Emscripten (el mismo mecanismo que ya funciona para `/persist/moodledata`).

## Riesgos conocidos

- **Disponibilidad de PDO SQLite**: Si php-wasm no incluye `pdo_sqlite`, se necesitaría un build custom o usar la clase `SQLite3` directamente.
- **Cobertura del traductor AST**: El DDL XMLDB de Moodle es más complejo que el de WordPress. Pueden aparecer 2-5 edge cases durante el bootstrap que requieran parches al traductor o pre/post-procesamiento en el driver.
- **ALTER TABLE limitado**: SQLite tiene soporte limitado de ALTER TABLE. El traductor AST maneja muchos casos pero algunos pueden fallar con tablas complejas de Moodle.
