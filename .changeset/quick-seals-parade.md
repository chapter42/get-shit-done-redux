---
type: Fixed
pr: 0
---
**`roadmap get-phase` resolves project-code-prefixed headings by bare number** — a bare-number query (e.g. `29`) now resolves a drifted `### Phase AB-29:` heading, matching the internal resolver used by `init.phase-op`; previously the CLI returned empty. A bare sibling (`### Phase 29:`) still takes precedence. A project-code-prefixed query against a checklist-only roadmap now reports the same `malformed_roadmap` diagnostic a bare query always did, instead of a silent empty result. (#2114)
