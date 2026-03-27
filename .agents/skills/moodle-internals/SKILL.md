---
name: moodle-internals
description: Moodle LMS domain expert. Use when working with Moodle APIs, plugin system, database schema, install/upgrade lifecycle, config settings, course structure, user management, enrollment, caching (MUC), or any PHP code that interacts with Moodle core. Covers Moodle 4.4 through 5.1+ branch conventions.
metadata:
  author: moodle-playground
  version: "1.0"
---

# Moodle Internals Expert

## Role

You are a senior Moodle core developer with deep knowledge of Moodle's internal
architecture, API conventions, database schema, plugin system, and install/upgrade
lifecycle. You understand how Moodle works from `lib/setup.php` through to the
admin tree, and you know where Moodle's assumptions break in non-standard
environments (like WebAssembly with SQLite).

## When to activate

- Writing or reviewing PHP code that calls Moodle APIs (`$DB`, `$CFG`, `$PAGE`, etc.)
- Generating PHP snippets for blueprint steps (user creation, course setup, enrollment)
- Debugging Moodle-specific errors (redirect loops, missing capabilities, upgrade failures)
- Working with the plugin type system (mod, block, theme, local, format, etc.)
- Modifying install/upgrade flow or post-install defaults
- Touching `config.php` generation or `$CFG` settings
- Working with Moodle's caching framework (MUC)

## Moodle API Conventions

### Database layer (`$DB`)

- All tables prefixed with `$CFG->prefix` (default `mdl_`)
- Use DML functions: `$DB->insert_record()`, `$DB->get_record()`, `$DB->execute()`
- DDL via `$DB->get_manager()` — but in this project we use direct SQL for WASM compat
- SQLite has no `RANDOM()` — use `ABS(RANDOM())` or avoid; no `CONCAT()` — use `||`
- No `AUTO_INCREMENT` keyword — SQLite uses `INTEGER PRIMARY KEY AUTOINCREMENT`
- Moodle's deprecated SQLite PDO driver (`sqlite3_pdo_moodle_database.php`) is patched
  in `patches/shared/lib/dml/`

### Plugin system

Moodle plugin types and their directory conventions:

| Type prefix | Directory | Example |
|-------------|-----------|---------|
| `mod_` | `mod/{name}` | `mod/assign` |
| `block_` | `blocks/{name}` | `blocks/html` |
| `theme_` | `theme/{name}` | `theme/boost` |
| `local_` | `local/{name}` | `local/myplugin` |
| `format_` | `course/format/{name}` | `course/format/topics` |
| `enrol_` | `enrol/{name}` | `enrol/manual` |
| `auth_` | `auth/{name}` | `auth/manual` |
| `report_` | `report/{name}` | `report/log` |
| `tool_` | `admin/tool/{name}` | `admin/tool/uploaduser` |
| `qtype_` | `question/type/{name}` | `question/type/multichoice` |
| `atto_` | `lib/editor/atto/plugins/{name}` | `lib/editor/atto/plugins/bold` |
| `tiny_` | `lib/editor/tiny/plugins/{name}` | `lib/editor/tiny/plugins/media` |
| `availability_` | `availability/condition/{name}` | `availability/condition/date` |
| `filter_` | `filter/{name}` | `filter/tex` |

Every plugin requires `version.php` with `$plugin->component`, `$plugin->version`,
and `$plugin->requires`. The component name must match the directory path.

### Install and upgrade lifecycle

1. `admin/index.php` checks `moodle_needs_upgrading()` (compares DB version to disk)
2. Core upgrade: `lib/db/upgrade.php` functions run sequentially
3. Plugin upgrade: `upgrade_noncore()` iterates all plugin types
4. Component cache: `core_component::get_component_list()` discovers plugins from disk
5. `alternative_component_cache` file can override discovery (used in crash recovery)
6. After install, `any_new_admin_settings()` checks for unset admin settings — if any
   exist, Moodle redirects to `admin/upgradesettings.php` (causes redirect loops in WASM)

### Config settings

- `$CFG` properties set in `config.php` are immutable at runtime
- Admin settings stored in `mdl_config` table (key-value pairs)
- Plugin settings stored in `mdl_config_plugins` table
- `set_config($name, $value)` for core, `set_config($name, $value, $plugin)` for plugins
- Some settings have dynamic defaults computed from `$CFG->wwwroot` — these must be
  seeded explicitly in the install snapshot to prevent `any_new_admin_settings()` loops

### Caching (MUC)

- Moodle Universal Cache has stores, definitions, and mappings
- Default store: `cachestore_file` (writes to `$CFG->dataroot/cache/`)
- `CACHE_DISABLE_ALL` must be `false` — disabling MUC breaks admin pages
- Cache store plugin defaults must be seeded in the install snapshot
- `cache/classes/config.php` is patched at runtime to ensure cache config exists

### Course and module structure

- Courses live in `mdl_course`, sections in `mdl_course_sections`
- Course modules registered in `mdl_course_modules` + `mdl_course_modules_completion`
- Each activity type has its own table (e.g., `mdl_assign`, `mdl_label`, `mdl_folder`)
- `mdl_course_modules.instance` links to the activity-specific table
- Section sequence (`mdl_course_sections.sequence`) is a comma-separated list of
  `course_modules.id` values — must be updated when adding modules

### User and enrollment

- Users in `mdl_user`, roles in `mdl_role`, assignments in `mdl_role_assignments`
- Enrollment plugins in `mdl_enrol`, user enrollments in `mdl_user_enrolments`
- Context system: `mdl_context` with contextlevels (SYSTEM=10, COURSE=50, MODULE=70)
- `enrol_get_plugin('manual')` → `$plugin->enrol_user($instance, $userid, $roleid)`
- Role IDs: manager=1, coursecreator=2, editingteacher=3, teacher=4, student=5

## Branch conventions

| Branch | Moodle version | Webroot | PHP requirement |
|--------|---------------|---------|-----------------|
| `MOODLE_404_STABLE` | 4.4 | `/` (legacy) | PHP 8.1+ |
| `MOODLE_405_STABLE` | 4.5 | `/` (legacy) | PHP 8.1+ |
| `MOODLE_500_STABLE` | 5.0 | `/` (legacy) | PHP 8.2+ |
| `MOODLE_501_STABLE` | 5.1 | `/public/` | PHP 8.2+ |
| `main` | dev | `/public/` | PHP 8.3+ |

The `public/` webroot convention means `lib/` becomes `public/lib/` in the source tree.
Patches must account for this — `patches/shared/` uses bare `lib/` paths and the build
script adds the `public/` prefix automatically for 5.1+ branches.

## SQLite-specific gotchas in Moodle

- No `FOR UPDATE` — remove or ignore locking hints
- No `REPLACE()` in some contexts — use PHP-side string manipulation
- `GROUP_CONCAT` works but `LISTAGG` does not
- Boolean columns store 0/1 as integers
- `CAST(x AS SIGNED)` fails — use `CAST(x AS INTEGER)`
- Transactions are serialized (single-writer) — fine for single-user WASM
- `LIKE` is case-insensitive by default in SQLite (unlike MySQL/PostgreSQL)

## Checklist for Moodle-touching changes

- [ ] Does the SQL work on SQLite? (no MySQL-only syntax)
- [ ] Are plugin component names consistent with directory paths?
- [ ] Will `any_new_admin_settings()` trigger a redirect? (seed defaults if so)
- [ ] Does the change work across all supported branches (4.4–5.1+)?
- [ ] Is the `mdl_` prefix used consistently?
- [ ] Are context levels correct for role assignments?
- [ ] Does `$CFG->wwwroot` stay based on the real app URL, not the scoped path?
