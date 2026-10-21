# sklavit-agent-skills

Agent skills and Claude Code mods. The repository is a Claude Code plugin marketplace.

| Plugin | Folder | Does |
| --- | --- | --- |
| `chat-panel` | `plugins/chat-panel/` | Side pane for one session: heads-up, summary, draft commit message, progress and findings, tests, notes, recaps |

## Install

At the prompt of a terminal session:

```
/plugin install chat-panel --marketplace sklavit/sklavit-agent-skills
```

From a shell:

```
claude plugin install chat-panel --marketplace sklavit/sklavit-agent-skills
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with
`sklavit/sklavit-agent-skills`, then Add plugin.

### chat-panel: Python tools

The hooks module runs its Python tools from `~/.claude/tools/chat-panel/`. Link that folder to the copy in this
repository once, after the clone:

```
mkdir -p ~/.claude/tools
ln -s "$PWD/plugins/chat-panel/tools" ~/.claude/tools/chat-panel
```

The tools need `python3` on the `PATH`. They keep their state in `~/.claude/tools/chat-panel/state/`.

## Develop

Load a plugin from its folder, without an install:

```
claude --plugin-dir plugins/chat-panel
```

Check and test it:

```
claude plugin validate plugins/chat-panel
claude plugin test plugins/chat-panel
```
