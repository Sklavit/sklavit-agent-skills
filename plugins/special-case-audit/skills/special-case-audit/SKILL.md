---
name: special-case-audit
description: Justify every new conditional, parameter or flag keyed on a new mode, key or "free vs paid" before it is written, and drop the ones that only defend the author's own earlier design choice. Use before implementing a plan that adds a branch to existing code, or when the user says "audit special cases" / "do I need this branch".
license: MIT
---

# Special-Case Audit

The deliverable is a table, not code. Run it after the approach is agreed and before the first edit.

## What counts as a special case

Any new or widened decision point whose condition is:

- a new schedule key, mode, source or type (`report_type == 'premium-export'`, `is_url_only`, `preview_only`)
- a price distinction (`is_free`, `fee == 0`, "at the normal price or for nothing")
- an org, plan or feature-flag check added only so the new feature can differ from the existing one
- a new optional parameter on an existing function that only the new caller passes
- a client-side bypass of an existing loop or guard ("process the whole batch", "skip chunking")

Widened means an existing condition gets an extra `or`/`and` term for the new case.

## Procedure

1. **List** every candidate from the plan or diff. Include the ones in specs (an AC that says "given an organisation that pays" is a special case in the requirements).
2. **For each candidate answer three lines:**
   1. **Overrides** — which existing behaviour it replaces. Cite `path:line`.
   2. **Breaks without it** — what concretely goes wrong if the existing path is reused unchanged. Must be a test name, an endpoint response, or a user-visible outcome. "It would be conceptually wrong" is not an answer.
   3. **Origin** — `product` (a requirement the user or ticket stated) or `own` (a consequence of a design choice made earlier in this branch or session; name the commit or decision).
3. **Verdict per row:**
   - Breaks-without-it empty → **drop**, reuse the existing path.
   - Origin `own` → **drop or revisit the earlier choice**. Do not add a second special case to defend the first.
   - Otherwise → **keep**, and write the one-line reason from row 2 as the code comment.
4. **Report** the table. Then stop and wait; do not start editing.

## Output format

```
| Candidate | Overrides | Breaks without it | Origin | Verdict |
|---|---|---|---|---|
| is_trial on has_active_order | billing/checks.py:120 blocks on order_type alone | paid export 409s after a trial run (test_export_after_trial) | own: trial recorded as premium-export in abc1234 | drop — accept the 409, or record trials under their own order_type |
```

Every row needs a citation in *Overrides* and a concrete artefact in *Breaks without it*. A row that cannot fill both columns is a drop.

## Rules

- Read-only. This skill produces analysis; edits come only after the user picks rows.
- Check the branch's own history (`git log <base>..HEAD`) when deciding *Origin*. A choice made two commits ago is still `own`.
- One special case that exists to make another special case work is two drops, not one keep.
- Specs and tests are in scope. If an AC or a test docstring encodes the special case, list it as a candidate too; a dropped branch takes its AC with it.
- When the honest answer to *Breaks without it* is "I don't know", say so and mark the row **unknown**; do not invent a failure.
