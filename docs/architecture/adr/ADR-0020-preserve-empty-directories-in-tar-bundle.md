# 0020 — Preserve semantically-meaningful empty directories in the tar.zst core bundle

* Status: Accepted
* Date: 2026-07-06

Amends the "files-only" determinism policy of [ADR 0018](ADR-0018-core-bundle-solid-compression-experiment.md)
and [ADR 0019](ADR-0019-streaming-tar-zstd-core-bundle-extraction.md): the tar writer now also emits
directory members for the handful of directories that ship empty after the build trim.

## Context and Problem

After the ZIP → `tar.zst` core-bundle migration (#176, ADR 0018/0019), installing the Moodle
Accessibility plugin (`local_accessibility`) — and in fact **any** `local` plugin — from a ZIP
fails during validation with:

> Coding error detected, it must be fixed by a programmer: Plugin type location does not exist!

The same plugin installs fine on a native Moodle. Root cause, traced end to end:

1. Moodle's `/local` directory ships with **only** `readme.txt` + `upgrade.txt`.
2. The bundle trim in `scripts/build-moodle-bundle.sh` excludes both (`-x "*/readme*"`,
   `-x "*/upgrade.txt"`). The trimmed core ZIP therefore carries `local/` **only as an explicit
   empty directory entry** (Info-ZIP keeps the directory member; it is not matched by any `-x`
   file pattern).
3. `normalizeEntries()` in `scripts/lib/tar-ustar.mjs` **dropped every directory member**
   (files-only policy, ADR 0018/0019), so `local/` never made it into the tar.
4. The streaming extractor reconstructs directories **only** from the parent path of each file it
   writes. With no file under `local/`, `<dirroot>/local` was never created at runtime.
5. `tool_installaddon`'s `\core\update\validator::validate_target_location()` does
   `if (!is_dir($plugintypepath)) throw new coding_exception('Plugin type location does not
   exist!');` — for a `local` plugin `$plugintypepath` is `<dirroot>/local`.

A census of the real `MOODLE_500_STABLE` trimmed bundle shows **6** such empty-after-trim
directories: `local`, `mod/lti/source` (the `ltisource` plugin-type root — same failure mode),
`backup/util/destinations`, `lang/en/fonts`, `lib/editor/tiny/js/tinymce/langs`, and
`lib/htmlpurifier/HTMLPurifier/DefinitionCache/Serializer` (HTMLPurifier's serializer cache dir).
All were silently missing at runtime before this change.

## Options Considered

* **Add `.gitkeep`/placeholder files** to force the directories to exist. Rejected: pollutes
  Moodle source, is plugin-specific, and fights archive semantics.
* **Special-case `local/`** (or plugin-type roots) in the trim or extractor. Rejected: a targeted
  hack that misses the five other empty dirs and any future ones.
* **Preserve ALL directory members** from the ZIP (every dir gets a typeflag-5 entry). Correct but
  adds ~5,000 redundant headers the extractor already recreates from file paths.
* **Preserve only directories with no file descendant** (chosen). The minimal, general set: the
  semantically-meaningful empty directories that would otherwise vanish. On the real bundle this
  is exactly 6 entries.

## Decision

**Preserve, as USTAR directory entries (typeflag `5`, size 0), exactly those source-ZIP
directory members that no kept file will implicitly recreate.** `normalizeEntries()` now returns
tagged entries (`{ type: "file", name, data }` / `{ type: "dir", name }`); a directory is emitted
only when its sanitized path is not an ancestor of any file entry. `createUstarTar()` writes a
trailing-slash typeflag-`5` header (mode `0755`) for those; the streaming extractor already
materializes directory entries via `mkdirTree`, so no runtime change was needed. Output stays
deterministic (single byte-wise sort over the combined list) and TAR-slip-safe (directory paths
run through the same `sanitizeArchivePath()` as files).

## Consequences

### Positive
* `<dirroot>/local` (and the 5 other empty-after-trim dirs) exist at runtime again — installing
  `local` and `ltisource` plugins from ZIP works, matching a native Moodle.
* Generic and future-proof: any directory a trim empties is preserved automatically; no
  plugin-specific or path-specific special-casing, and no placeholder files in Moodle source.
* Negligible cost: 6 extra 512-byte headers on the real bundle (compresses to ~nothing); the
  files-only determinism, checksum, and file-count parity guarantees are unchanged.

### Negative / Risks
* The tar is no longer strictly files-only, so the ADR 0018/0019 "files-only" wording is amended
  here. `fileCount` remains files-only (directories are reported separately as `dirCount`), so the
  manifest `bundle.fileCount` and the runtime parity tripwire (`extractStats.fileCount`) are
  unaffected.
* `scripts/lib/tar-ustar.mjs` and `lib/streaming-tar-extract.js` are the **canonical** shared kit,
  copied verbatim into the sibling `*-playground` repos — this change should be synced there.

## Implementation Notes

* `scripts/lib/tar-ustar.mjs` — `normalizeEntries()` preserves empty directories (ancestors of
  kept files are excluded via an `impliedDirs` set); `createUstarTar()` emits typeflag-`5`
  directory headers; `readUstarTar()` surfaces `{ name, type: "dir" }`.
* `scripts/build-tar-zst-from-zip.mjs` — reports `fileCount` (files only) and `dirCount`
  separately so the manifest count stays files-only.
* `lib/streaming-tar-extract.js` — unchanged; it already handles typeflag-`5`/trailing-slash
  directory entries (`StreamingTarParser` → `ensureDir`/`mkdirTree`).
* Tests: `tests/scripts/tar-ustar.test.js` (preservation, typeflag-5 round-trip, no-redundant-dir,
  path-traversal, determinism) and `tests/runtime/streaming-tar-extract.test.js` (writer → parser
  round-trip; `extractTarStreamToPhp` creates the empty dir via `mkdirTree`).
* No `npm run build-worker` needed for the runtime (no runtime JS changed), but the core `tar.zst`
  bundle must be **rebuilt** (`make prepare`) for the fix to reach a running app.

## Review Criteria

* Revisit if the trim's exclusion list changes such that a different set of directories is
  emptied, or if a plugin-type root is added under a path the trim empties.
* Revisit if the sibling-repo kit sync introduces a divergent directory policy.
* Re-measure the preserved-dir census when bumping the Moodle branch (a new empty-after-trim
  directory should appear here, not as a runtime "location does not exist" error).
