---
id: SDD-0000
title: "Short design title"
status: Draft
date: YYYY-MM-DD
authors:
  - "@github-user"
reviewers:
  - "@github-user"
related:
  issues: []
  prs: []
  adrs: []
  sdds: []
supersedes: []
superseded_by: []
ai_assistance:
  tool: ""
  model: ""
---

<!--
How to use this template:
1. Copy this file to `SDD-NNNN-short-kebab-case-title.md` with the next free ID.
2. Update the frontmatter above (id, title, date, authors, reviewers, related).
3. Fill the relevant sections. Delete sections that truly do not apply, and
   delete these guidance comments before submitting.
4. Use an SDD for significant proposals, not small fixes.
5. Cite a verifiable source for each technical claim (repo path + commit,
   documentation, benchmark, experiment, issue, PR, or ADR).
6. Capture durable decisions in "ADRs required or referenced" — link an existing
   ADR or mark it "ADR needed".
7. Record AI assistance in `ai_assistance` (values, or `none` if not used).
Editing is free while Draft / In Review. Once Implemented, only fix typos/links.
See README.md for the full policy.
-->

# SDD-0000: Short design title

## Status

Draft

<!-- One of: Draft | In Review | Accepted | Implemented | Superseded | Abandoned.
Keep it in sync with the frontmatter `status`. -->

## Summary

<!-- One or two paragraphs: what this changes and why it matters. -->

## Problem statement

<!-- The problem being solved, and who has it. -->

## Goals

<!-- What success looks like. Make these testable where possible. -->

## Non-goals

<!-- What this design explicitly does not attempt. -->

## Current state

<!-- How things work today. Cite repository paths + commits. -->

## Proposed design

<!-- The design at a high level. Diagrams welcome. -->

## User experience

<!-- What users see and do. Flows, states, edge cases. -->

## Technical design

<!-- Components, modules, interfaces, data flow. Cite the files that will
change. Remember the shell/remote/sw/worker split and the worker-rebundling
rule for anything under src/blueprint/**. -->

## Data model

<!-- New/changed structures: blueprint schema, SQLite tables, MEMFS layout,
manifests, config.php values, IndexedDB journal shape. -->

## Migration and compatibility

<!-- Backward compatibility (blueprints, URLs, persisted journals, bundle
manifests), feature flags, rollback. -->

## Security and privacy

<!-- Sanitization, proxy allowances, URL/scope handling, secrets. -->

## Accessibility

<!-- Keyboard, screen readers, contrast, focus management, WCAG considerations. -->

## Performance

<!-- Expected cost: boot time, memory (WASM heap), bundle size, request latency.
Budgets and profiling hooks ([blueprint-perf], ADR-0021). -->

## Testing strategy

<!-- Unit (node:test), E2E (Playwright), manual browser verification. Which
flows get a spec in tests/e2e/. -->

## Rollout plan

<!-- Phases, order of merges, staged enablement. -->

## Risks and mitigations

<!-- What could go wrong, likelihood/severity, and how it is mitigated. -->

## Open questions

<!-- Unresolved points that reviewers should weigh in on. -->

## ADRs required or referenced

<!-- List durable decisions. Link an existing ADR, or mark it "ADR needed". -->

| Decision | ADR | Status |
|---|---|---|
| Example durable decision | ADR-XXXX | Proposed |

## Evidence

<!-- The verifiable basis for the design: repo paths + commits, docs, benchmarks,
reproducible experiments, issues, PRs, ADRs. No technical claim without a source. -->

## Acceptance criteria

<!-- Concrete, checkable conditions for "done". -->

- [ ] ...

## Implementation checklist

<!-- The steps to build it, roughly in order. -->

- [ ] ...

## References

<!-- All sources cited above, plus related issues, PRs, ADRs and SDDs. -->
