---
name: review-report
description: Formats PR / code-review findings as an HTML page with one table row per finding — location + severity, issue, what goes wrong, evidence, Jira ticket check (ticket and its parent), and three fix suggestions. Use when the user asks to format, present or publish review results, wants review findings "as a table", "as HTML", "as an artifact", or types /review-report. Also use as the output step after a code review or PR review the user asked to see in this format.
license: MIT
---

# Review report

Turn review findings into one HTML table. The review itself (finding bugs) happens before this skill; this skill
formats, checks against Jira, and publishes.

## Steps

1. **Collect findings.** Use the findings already in the conversation. If none exist, run the review first
   (`/code-review`, a review agent, or a manual read of the diff) and keep only verified findings.
2. **Find the ticket.** Take the first `[A-Z][A-Z0-9]+-\d+` key from, in order: the user's message, the PR title
   (`gh pr view` or your forge's CLI), the branch name, the latest commit subjects. No key → ask once; if the user
   has none, set `ticket` to `null` and every `ticket_check.verdict` to `no-ticket`.
3. **Read the ticket and its parent.** Atlassian MCP `getJiraIssue` on the key; read `fields.parent.key`
   (epic or story) and fetch that too. Keep summary, status, type, URL, and the acceptance criteria or
   description bullets. If MCP is not authenticated, say so in the page header and use `no-ticket`.
4. **Check each finding against the tickets.** Pick one verdict and write a one-line note that names the
   AC or the parent goal:
   - `breaks-ac` — the defect makes a ticket or parent requirement fail.
   - `in-scope` — the defect is in code the ticket asked for; no AC names it directly.
   - `out-of-scope` — the defect is in a change the ticket and parent do not ask for (scope creep).
   - `pre-existing` — the defect exists on the base branch; the PR only touches it.
   - `no-ticket` — no ticket available.
5. **Write three fixes per finding**, best first. Make them different in kind (for example: minimal local fix /
   structural fix / test or guard), not three wordings of one idea. Mark the first as recommended. Each fix is
   one or two sentences, concrete enough to act on.
6. **Write the JSON** to the scratchpad (`review-<target>.json`), shape in [Data shape](#data-shape).
7. **Render** with `render.py` from this skill's directory (in Claude Code:
   `${CLAUDE_PLUGIN_ROOT}/skills/review-report/render.py`):
   `uv run --no-project python <skill-dir>/render.py <json> <out.html>` (plain `python3` works too; stdlib only).
   Default output path: scratchpad, `review-<target>.html`.
8. **Deliver.**
   - Default: open the local file (`open` on macOS, `xdg-open` on Linux).
   - User asked for an artifact / a link to share: publish `<out.html>` with the Artifact tool (icon `review`).
   - Terminal reply: counts by severity, ticket keys, the file path or link. Do not repeat the table.

## Severity

| Tag | Meaning |
|-----|---------|
| `critical` | Data loss, security hole, wrong money, crash on the main path. Blocks merge. |
| `high` | Wrong result on a realistic path; breaks an AC. Blocks merge. |
| `medium` | Wrong result on an edge path, or a missing test for a risky change. |
| `low` | Maintainability, misleading name, weak test. |
| `nit` | Style only. |

Sort rows by severity, then by file.

## Cell rules

- `location`: `path:line` or `path:start-end`, repo-relative. One finding may list several locations.
- `issue`: one sentence, the defect itself.
- `impact` ("What goes wrong"): concrete input/state → wrong output. Name the user-visible effect.
- `evidence`: what proves it — quoted code, a test run, a trace, a diff hunk, a log line. Cite `path:line`.
  Mark unverified reasoning with `(inferred)`.
- Inline code in any text field: wrap in backticks; the renderer turns them into `<code>`.
- British spelling. Short sentences.

## Data shape

```json
{
  "title": "Review — PR #42 PROJ-123",
  "target": "PROJ-123-add-export-schedule vs main",
  "reviewed_at": "2026-10-06",
  "note": "optional free text shown under the header",
  "ticket": {"key": "PROJ-123", "summary": "...", "type": "Story", "status": "In Review",
             "url": "https://<site>.atlassian.net/browse/PROJ-123", "criteria": ["AC 1 ...", "AC 2 ..."]},
  "parent": {"key": "PROJ-100", "summary": "...", "type": "Epic", "status": "In Progress",
             "url": "...", "criteria": []},
  "findings": [
    {
      "locations": ["src/api/routes/export.py:120"],
      "severity": "high",
      "issue": "...",
      "impact": "...",
      "evidence": "...",
      "ticket_check": {"verdict": "breaks-ac", "note": "PROJ-123 AC 2: ..."},
      "fixes": ["recommended fix", "alternative", "alternative"]
    }
  ]
}
```

`ticket` / `parent` may be `null`. `fixes` must have exactly three entries; the renderer warns otherwise.

Done = the HTML opens (or the artifact link exists), every finding has a severity, evidence and three fixes, and
the ticket check names the ticket keys it used.
