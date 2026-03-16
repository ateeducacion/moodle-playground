---
name: Moodle 5.1+ public directory restructuring
description: Moodle 5.1 and dev/main moved all web-accessible files (admin/, lib/, cache/, etc.) into a public/ subdirectory. config.php stays at root level (above public/).
type: project
---

Moodle 5.1 (MOODLE_501_STABLE) and dev (main branch) restructured the directory layout: all web-accessible files moved into `public/` (e.g., `admin/index.php` → `public/admin/index.php`, `lib/setup.php` → `public/lib/setup.php`). `config.php` remains at the project root, one level above `public/`.

**Why:** Moodle upstream adopted this structure starting in 5.1 for security (keeping non-web files out of the document root).

**How to apply:** In moodle-playground, the VFS mount is at `/www/moodle`. For 5.1+, the "web root" (where PHP scripts live, `$CFG->dirroot`) is `/www/moodle/public`, while `config.php` stays at `/www/moodle/config.php`. The `webRoot` property in `version-resolver.js` already encodes this (`"/www/moodle"` for <=5.0, `"/www/moodle/public"` for 5.1+). All runtime paths for Moodle core files (patching, settings overrides, script resolution in php-compat.js) must use `webRoot` instead of `MOODLE_ROOT`.
