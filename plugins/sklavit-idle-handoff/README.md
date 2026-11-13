# sklavit-idle-handoff

A Claude Code mod. After the session is idle for a set time, it runs `/mattpocock-skills:handoff` while the
prompt cache is still warm. The handoff document goes to the OS temporary directory. When you come back
after the cache has expired, run `/clear` and continue from that document instead of a big, cold context.

## Install

```
/plugin install sklavit-idle-handoff --marketplace sklavit/sklavit-agent-skills
```

## Requirements

- Claude Code with mods (2.1.287 or later).
- The `mattpocock-skills` plugin, for the `handoff` skill.
- A 1-hour prompt cache (a Claude subscription). On a 5-minute cache the handoff runs on a cold cache.

## What it does

- After each main-loop turn, it starts a timer. The next turn or the end of the session cancels it.
- When the timer fires, it reads the conversation size (the Messages row of `/context`). Below
  `minTokens` it does nothing and writes a line to the transcript.
- Otherwise it runs `/mattpocock-skills:handoff` with a brief as the argument. The brief tells the model to
  keep the goal, the next action, the files, the decisions, the blockers and the state.
- It runs one handoff for each idle stretch. The handoff turn does not start a new timer.
- A reload of the mod keeps the time of the last turn and starts the timer again for the time that is left.

## Configure

| Option | Default | Meaning |
| --- | --- | --- |
| `idleMinutes` | `50` | Minutes idle before the handoff. |
| `minTokens` | `40000` | Skip conversations smaller than this. System prompt and tools do not count. |

## Limits

- The handoff does not make the context smaller. The saving comes from `/clear` after you come back.
- The mod does not know the path of the handoff document. The handoff turn shows it in the transcript.
- If the handoff turn asks for permission to write the file, it waits for you.

## Credits

- The timer, size gate and reload logic follow
  [idle-compact](https://github.com/davidar/claude-idle-compact) by David Roberts (MIT).
- The brief is the one from [better-compact](https://github.com/koenvdheide/better-compact) by
  Koen van der Heide (MIT).
