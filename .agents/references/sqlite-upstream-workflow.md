# SQLite Upstream Workflow

How to handle SQLite-related bugs and where the upstream driver code lives.

## Repositories

| Repository | Purpose |
|------------|---------|
| [ateeducacion/moodle-playground](https://github.com/ateeducacion/moodle-playground) | Browser-based Moodle (WASM runtime). Issues are tracked here. |
| [ateeducacion/moodle](https://github.com/ateeducacion/moodle) | Moodle fork with SQLite driver patches. PRs for upstream Moodle tracker. |

## Upstream branches (ateeducacion/moodle)

| Branch | Moodle version | PR | Driver path |
|--------|---------------|-----|-------------|
| `MDL-88218-sqlite-500` | 5.0 | [#3](https://github.com/ateeducacion/moodle/pull/3) | `lib/dml/sqlite3_pdo_moodle_database.php` |
| `MDL-88218-sqlite-501` | 5.1 | [#2](https://github.com/ateeducacion/moodle/pull/2) | `public/lib/dml/sqlite3_pdo_moodle_database.php` |
| `MDL-88218-Add-experimental-SQLite-support-for-Moodle-WASM-environments` | main | [#1](https://github.com/ateeducacion/moodle/pull/1) | `public/lib/dml/sqlite3_pdo_moodle_database.php` |
| `mdl-88218-workbench` | main (dev) | — | `public/lib/dml/sqlite3_pdo_moodle_database.php` |

**Important**: The 5.0 branch has files under `lib/` (no `public/` prefix). The 5.1 and main branches use `public/lib/`.

## Key SQLite files

In `ateeducacion/moodle`:

- `sqlite3_pdo_moodle_database.php` — DML driver (queries, connections, column introspection)
- `sqlite_sql_generator.php` — DDL generator (CREATE TABLE, ALTER TABLE emulation, temp tables)

In `ateeducacion/moodle-playground` (patches applied at build time):

- `patches/shared/lib/dml/sqlite3_pdo_moodle_database.php`
- `patches/shared/lib/ddl/sqlite_sql_generator.php`

## When you find a SQLite bug

### 1. Identify whether it is a driver bug or a WASM/runtime bug

- **Driver bug**: errors from `sqlite3_pdo_moodle_database.php` or `sqlite_sql_generator.php` (DML/DDL layer). These affect both the WASM runtime and native PHP with SQLite.
- **Runtime bug**: errors from bootstrap, service worker, PHP-WASM compat layer. These only affect the browser runtime.

If the error is in the DML/DDL layer, it is a driver bug and must be fixed upstream in `ateeducacion/moodle`.

### 2. Fix and test on the workbench branch

```bash
# Clone ateeducacion/moodle if you haven't already
cd /path/to/ateeducacion/moodle
git checkout mdl-88218-workbench

# Start local PHP server with SQLite
make up

# Test at http://localhost:8081 (admin/password)
# Reproduce and verify the fix
```

### 3. Replicate to all maintained branches

Once verified on the workbench, apply the same fix to all three upstream branches:

```bash
# For each branch:
git checkout origin/<branch> -B <branch>
# Apply the fix (adjust path for 5.0 if needed)
# Commit with the same message
git push origin <branch>
```

### 4. Update the playground patches

If the fix also affects the WASM build, update the corresponding patch file in this repository:

```bash
# Copy the fixed file to the patches directory
cp /path/to/fixed/sqlite3_pdo_moodle_database.php patches/shared/lib/dml/
# Or for the DDL generator:
cp /path/to/fixed/sqlite_sql_generator.php patches/shared/lib/ddl/
```

Then trigger a rebuild (manually via GitHub Actions or by pushing to main).

### 5. Close the issue

Comment on the issue in `ateeducacion/moodle-playground` with:

- Root cause analysis
- What was fixed
- Links to the updated PRs in all three branches

## Known SQLite gotchas

- **Temporary tables** live in `sqlite_temp_master`, not `sqlite_master`. Any method querying table metadata must check both catalogs with `UNION ALL`.
- **ALTER TABLE** is very limited in SQLite. The DDL generator emulates it by recreating the entire table (copy to temp → drop → create new → insert from temp).
- **No concurrent writes** — SQLite uses file-level locking.
- **Type affinity** — SQLite is loosely typed. Integer/text mismatches may not error but can cause subtle bugs.

## Triggering a rebuild

When SQLite patches change in `ateeducacion/moodle`, the playground bundles need to be rebuilt. Use the **manual workflow dispatch** in GitHub Actions:

1. Go to [Actions → CI](https://github.com/ateeducacion/moodle-playground/actions/workflows/ci.yml)
2. Click **Run workflow**
3. Select the `main` branch
4. Optionally add a reason (e.g., "SQLite driver patch updated")
5. Click **Run workflow**

This will rebuild all 5 Moodle branch bundles with the latest patches and deploy to GitHub Pages.
