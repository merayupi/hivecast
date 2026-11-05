# Domain Docs

## Layout: single-context

- `GLOSSARY.md` at the repo root holds domain vocabulary.
- `docs/adr/` holds architectural decision records.

## Before exploring

Read `GLOSSARY.md` and ADRs relevant to the area being explored.

If these files or directories do not exist, proceed silently without proposing their creation upfront. `/domain-modeling`, reached through `/grill-with-docs` or `/improve-codebase-architecture`, creates them lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

Use glossary terms when naming domain concepts in issue titles, refactor proposals, hypotheses, and tests. Respect any explicitly avoided synonyms.

If a needed concept is missing, reconsider whether it belongs to the project's language; otherwise note the gap for `/domain-modeling`.

## Surface ADR conflicts

If a proposal contradicts an existing ADR, identify the ADR and explain why the decision should be reopened rather than silently overriding it.
