# Internal notes

!!! note "Maintainer material, not user docs"
    The pages linked below are maintainer notes and design history kept in the
    repository but intentionally left out of the public navigation. They are aimed
    at contributors, may be incomplete, and can be outdated. Treat them as background,
    not as authoritative user documentation.

## Agent and domain guidance

The authoritative guide for working in this codebase (human or AI) is
[`AGENTS.md`](https://github.com/ateeducacion/moodle-playground/blob/main/AGENTS.md)
at the repository root. Deep, per-domain references live in the skill files under
[`.agents/skills/`](https://github.com/ateeducacion/moodle-playground/tree/main/.agents/skills)
(Moodle internals, WP Playground & php-wasm, WASM & browser runtime, blueprint
provisioning, unit testing, and E2E testing).

## Architecture Decision Records and Software Design Documents

Significant technical decisions are recorded as ADRs in
[`docs/architecture/adr/`](../architecture/adr/README.md) — see the
[ADR index](../architecture/adr/records.md). Each ADR captures the context,
options considered, rationale, and consequences of a decision — read them before
changing the request pipeline, the storage model, the build, or blueprint semantics.

Significant designs are gated by SDDs in
[`docs/architecture/sdd/`](../architecture/sdd/README.md) — see the
[SDD index](../architecture/sdd/records.md). An SDD describes what a large
change builds and how; durable decisions inside it link to ADRs.

## Design history and deep dives

- [SQLite + php-wasm migration notes](../sqlite-wasm-migration-notes.md) — how Moodle
  runs against the experimental SQLite PDO driver in WASM, and the invariants to preserve.
- [Moodle WASM plan](../internal/moodle-wasm-plan.md) — original plan for running Moodle
  in the browser.
- [Implementation status](../internal/implementation-status.md) — progress snapshot of
  the WASM port.
- [Plugin install notes](../internal/plugin-install-branch-notes.md) — notes on the
  plugin/theme installation path.
- [PHP process manager evaluation](../internal/research/php-process-manager-evaluation.md) —
  research on `rotatePHPRuntime` and process management options.

## Troubleshooting and known issues

- [Troubleshooting](../TROUBLESHOOTING.md) — developer-oriented debugging guide.
- [Known issues](../KNOWN-ISSUES.md) — current limitations and open problems.

For user-facing setup and tasks, start from the [Home page](../index.md) and the
[Contributing guide](contributing.md).
