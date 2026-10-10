---
name: investigate
description: Answer a question read-only — no edits, no git, no fixes, no volunteered remediation. Use when the user asks to investigate, trace, analyse or explain something without changing it, and whenever a message contains "DO NOTHING", "do nothing only advise", "just investigate", "just analyse without code changes", "ONLY review, NO CODE CHANGES", "DO NOT CHANGE CODE", "only review", "don't touch", "don't change", "read-only", "just tell me", "just check", "what is X", "where is Y", "why does X happen", "how does X work". Also use when the user interrupts to say they wanted an answer rather than an action.
license: MIT
---

# Investigate

The deliverable is an **answer**, not a change and not a plan.

## Does this apply?

Yes: comprehension, feasibility, diagnosis, "where/why/how does X".

**No — if the message asks for a change, even phrased as a question.** "Can we move X into Y?", "could we set the DB to production timezone?" are work requests. Do not use this skill for them; a question mark is not a read-only signal.

Ambiguous? Answer first, then ask whether they want it done.

## Turn on the guard (Claude Code only)

When this plugin is installed in Claude Code, a PreToolUse hook (`hooks/investigate-guard.sh`, needs `jq`) blocks Edit/Write and mutating Bash while a per-session marker exists. First action, before any other tool call — `<uuid>` is the session id, the UUID directory in your scratchpad path:

```bash
mkdir -p ~/.claude/investigate-mode && touch ~/.claude/investigate-mode/<uuid>
```

Clear it **only** when the user asks for action:

```bash
rm ~/.claude/investigate-mode/<uuid>
```

Never clear it on your own initiative. If the hook blocks you, that is the mode working — report the finding instead of routing around it. On surfaces without hooks (claude.ai), follow the rules below without the guard.

## Rules

1. **Lead with a 2–3 line TLDR.** The direct answer first, evidence after.
2. **Read-only.** `cat`, `grep`, `find`, `ls`, `git log`/`show`/`diff`, status commands. Nothing that mutates, installs, commits, or runs the test suite. If a check would mutate, describe it and stop.
3. **Answer the question asked. Then stop.** No appendix of what they *could* do next.
4. **Feasibility gets a verdict, not a runbook.** "Can I uninstall X?" → yes/no + why. Commands only on request.
5. **No unsolicited extras.** No "what you can also clean up", no "middle option", no "recommended next steps", no offering to implement.
6. **Ground every claim in output you ran.** Quote the line. Say "unknown" rather than infer.
7. **If a fix is needed**, describe it in a fenced diff block and wait. Do not apply it.
8. **Subagents inherit this.** Put the read-only and no-git constraints verbatim in every Task prompt — the parent session's mode does not propagate.

One short closing line offering to act is the maximum, and only when a fix is genuinely implied.

## Note

Escalation to CAPS ("DO NOTHING") means an earlier answer drifted into action. Re-read the question and answer only that.
