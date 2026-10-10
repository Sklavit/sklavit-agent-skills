# sklavit-agent-skills

Agent skills for Claude (or any agent that reads `SKILL.md`), packaged as a **Claude plugin marketplace**.

## Install

**claude.ai / Claude Desktop** — Customize → Plugins → Add → Add marketplace → Add from a repository → `Sklavit/sklavit-agent-skills` → Sync. Turn on *Sync automatically* to pick up new commits. Requires *Code execution and file creation*.

**Claude Code**

```
/plugin marketplace add Sklavit/sklavit-agent-skills
/plugin install investigate@sklavit-agent-skills
```

Plugins enabled on claude.ai also load in Claude Code when you sign in with the same account.

**Other agents** (Cursor, Codex, Gemini CLI…) — copy `plugins/<name>/skills/<name>/` into the agent's skills folder, or use a sync tool such as [skillshare](https://github.com/runkids/skillshare).

## Plugins

| Plugin | What it does |
|---|---|
| `investigate` | Read-only answer mode. In Claude Code a PreToolUse hook blocks edits/mutating Bash while active (needs `jq`). |
| `special-case-audit` | Table that justifies every new conditional/flag before it's written; drops branches that only defend your own earlier design. |
| `review-report` | Code-review findings → HTML table: severity, evidence, Jira ticket check, three fixes. |
| `linkedin-tech-posts` | LinkedIn posts and Medium articles for engineers. |

## Upstream skills I use

Listed in `marketplace.json` as links to the authors' repos (not copied), so they update from source:

| Plugin | Author | Repo | Skills |
|---|---|---|---|
| `obsidian` | Steph Ango (MIT) | [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) | obsidian-markdown, obsidian-bases, obsidian-cli, json-canvas, defuddle |
| `mattpocock-skills` | Matt Pocock (MIT) | [mattpocock/skills](https://github.com/mattpocock/skills) | grill-me, grill-with-docs, write-a-skill, and more |

If an upstream entry doesn't resolve on your surface, add the author's marketplace directly (`/plugin marketplace add kepano/obsidian-skills`).

## Layout

```
.claude-plugin/marketplace.json        # catalogue
plugins/<name>/.claude-plugin/plugin.json
plugins/<name>/skills/<name>/SKILL.md  # + scripts/, references/
plugins/<name>/hooks/hooks.json        # optional, Claude Code only
```

Adding a skill: create `plugins/<name>/` with the files above, add an entry to `marketplace.json`, run `claude plugin validate .`. Reference bundled files relative to the skill dir or via `${CLAUDE_PLUGIN_ROOT}` — never `~/.claude/skills/<name>`.

## Licence

MIT — see [LICENSE](LICENSE). Upstream plugins keep their own licences.
