# chat-panel

A side pane for one Claude Code session. It shows what the session is about, what it has done and how the
tests stand, so the person can follow long multi-step work without a scroll back through the chat.

The mod has two halves:

| Half | Location | Does |
| --- | --- | --- |
| Hooks module | `~/.claude/skills/chat-panel/` | collects session events, calls haiku, draws the native pane |
| Python tools | `~/.claude/tools/chat-panel/` | keeps the state files, reruns tests, draws the cmux / tmux pane |

The hooks module reads and writes the state only through `control.py`. Both panes read the same files,
so both show the same content.

## Install

```
/plugin install chat-panel --marketplace sklavit/sklavit-agent-skills
```

Then link the Python tools: see the repository README.

## Sections

The pane shows these sections, top to bottom. A section with no data stays hidden, except Heads up,
Summary, Draft commit message, Notes and Recaps, which show a placeholder.

| Section | Content | Source |
| --- | --- | --- |
| ⚑ Heads up | the you-should-know headline; dimmed after it is dismissed | the `cc-plugin-you-should-know` store |
| ≡ Summary | the text of the last `/summary` | the `summary` skill |
| ✉ Draft commit message | a commit message for the changes against HEAD | haiku, from `git diff HEAD` |
| ☑ Progress | the multi-step work: `✔` done, `▶` in progress, `☐` to do | haiku, from tool calls and text |
| ⚗ Tests | each test file the session touched, with the result of its last run | tool calls, pytest output, reruns |
| ✎ Notes | the notes saved with `/note` | the `note` skill |
| ↺ Recaps | the last 3 recaps: `/recap`, away recaps and one per answered turn | transcript, haiku |

The footer shows the git branch.

## Controls

The native pane has buttons and one select. To use them, give the pane the focus: click it, or press
ctrl+x tab. A hotkey works while the pane has the focus. Esc gives the focus back to the prompt. The cmux
pane has no controls.

| Section | Control | Hotkey | Effect |
| --- | --- | --- | --- |
| top right | `help` | `i` | shows or hides a short help for each section and control (`HELP` in `hooks/data.ts`) |
| Heads up | `generate` | `h` | haiku writes a heads-up from the last answer, the checklist and the tests |
| Summary | `/summary` | `s` | runs the `summary` skill; the summary shows when that turn ends |
| Draft commit message | `generate from diff` | `g` | haiku drafts the message from the current diff now |
| Draft commit message | `generate from chat` | `t` | haiku drafts it from the checklist, summary, recaps, last answer |
| Draft commit message | `commit` | `m` | fills the prompt box with "Commit … with this message: <draft>" |
| Progress | `Item:` select | | selects the item for the three buttons below it |
| Progress | `done`, `remove` | `d`, `x` | marks the selected item done, or removes it |
| Progress | `compact` (2+ done items) | `k` | haiku merges the done items into fewer items; the others stay |
| Progress | `continue` | `n` | fills the prompt box with "Continue with: <item>" |
| Tests | `rerun` | | reruns that file now |
| Tests | `fix` (failed files) | | fills the prompt box with "Fix the failing tests in <file>: <names>" |
| Tests | `write` (proposed tests) | | fills the prompt box with "Write the proposed test <name>" |
| Notes | `clear` | `c` | deletes the notes |
| Recaps | `/recap` | `p` | runs `/recap`; its text joins the recaps |

A control that writes a prompt fills the prompt box and does not send it: the person reads and edits
the prompt first. Each control shows a toast with its result. A slow control (`k`, `h`, `g`, `t`, rerun) also
shows a toast when it starts.

A generated heads-up shows in place of the you-should-know headline while it is the newer of the two.

The engine follows `$` only into functions at the top level of `hooks/register.tsx`. Thus each control
calls a top-level function (`headsUp()`, `rerunFile()`, `fillPrompt()`, `changeSelected()`,
`runCommand()`, `clearNotes()`, `toggleHelp()`, `generateCommit()`,
`generateCommitFromChat()`, `compactProgress()`), never a closure made inside `register`.

## How each section updates

### Recaps and Progress

1. The `tool.call` hook records a short label for each tool call of the main conversation.
   `toolLabel()` and `findingLabels()` in `hooks/data.ts` make the labels.
2. The `session.append` hook records the visible text of each response row: the text the assistant
   writes between tool calls. `responseText()` in `hooks/data.ts` drops thinking and tool calls.
3. At the end of an answered turn, the `turn.complete` hook stores the answer, the labels and the text
   as a pending turn.
4. The 2-second poll takes the pending turn and makes two haiku calls:
   - `addRecap()` writes a one-line recap.
   - `addProgress()` sends the current checklist, the labels, the text and the answer. Haiku replies
     with the updated checklist, or with `UNCHANGED` for a question, a discussion or an options list.
5. While a turn runs, the poll also refreshes the checklist from the text so far.
   `shouldRefreshMidTurn()` limits this to one call each `MID_TURN_MS` (60 s), and only after new text.

The turn buffer and the pending turn live in `$.state` (`chat-panel.turn` and `chat-panel.pending`).
A save of the mod's files reloads the module at the end of the turn; `$.state` keeps both values through
the reload, so that turn still gets its recap and its checklist.

`PROGRESS_SYSTEM` in `hooks/data.ts` holds the rules for the checklist: which steps stay, how a finished
step reads, and which turns change nothing. Change the checklist behaviour there.

### Draft commit message

At the end of each answered turn, the poll runs `control.py commit-diff`: `git diff HEAD --stat` and
`git diff HEAD` in the session's directory. The draft covers staged and unstaged changes to tracked
files; untracked files are not in it. When the hash of the diff differs from the one of the current
draft (`chat-panel.commitKey` in `$.state`), `draftCommit()` asks haiku for a new draft. haiku gets the
stat, the first `DIFF_CHARS` (12000) characters of the diff and the ticket id from the branch name
(`ticketOf()`). `COMMIT_FORMAT` in `hooks/data.ts` holds the format rules. The mod never commits.

A large diff is cut, so haiku sees the later files only in the stat. `generate from chat` uses the
session's checklist, summary, recaps and last answer instead (`COMMIT_CHAT_SYSTEM`): its prompt stays
small whatever the size of the diff, but it misses changes the session does not mention. The next
automatic draft from the diff replaces it only when the diff changes again.

### Tests

pytest only.

| Event | Effect |
| --- | --- |
| `Edit`, `Write` or `NotebookEdit` on `test_*.py` / `*_test.py` | `?` (not run) or `↻` (changed since its last run) |
| a foreground `Bash` command that runs pytest | its output is parsed for per-file results |
| the end of each turn | the files changed since their last run are rerun in the background |
| an answer that mentions tests | haiku lists the tests the answer proposes; they show as `✎` |

The other marks: `✔` passed, `✘` failed (the failing test names show below the file), `◌` running,
`⏱` timed out, `!` error.

The rerun:

- runs `<testCommand> <files> -q -p no:cacheprovider -o junit_family=xunit1 --junitxml=<temp file>` in
  the session's working directory, so the results are exact;
- stops after `RUN_TIMEOUT_S` (300 s);
- waits while the assistant runs pytest, or while another rerun goes;
- marks a file `↻` when the file changed during the run.

The parser of the assistant's own runs (`parse_output()` in `tests_tracker.py`) is best effort:

- With the default output, pytest prints one progress line per file, and the counts are exact.
- With `-q` or `-n` (xdist), pytest prints no file names. For a run of one file, the summary counts
  apply to that file. For a run of several files, only the `FAILED` / `ERROR` lines give results, and a
  run with no failure marks each named file "passed" with no count.
- A run of a folder names no file, so only files with a progress line or a `FAILED` line get a result.

`tests_tracker.py` is the only writer of `state/<session>.tests.json`. Each write takes an exclusive lock
(`locked()`), so a hook and a long rerun cannot overwrite each other.

## Options

Set them in the `/plugin` config menu, or in `~/.claude/settings.json` under `pluginConfigs`.

| Option | Default | Effect |
| --- | --- | --- |
| `mode` | `native` | `native`: a Claude Code pane. `cmux`: a split to the right in cmux, or in tmux |
| `autoOpen` | `true` | open the pane when a session starts; else open it with `/panel` |
| `testCommand` | `uv run pytest --no-cov` | the rerun command, before the file names; empty: no rerun |

## Commands

`/panel [open|close|status|native|cmux]` opens, closes or reports the pane.

`control.py` actions (`python3 ~/.claude/tools/chat-panel/control.py <action> [session] ...`):

| Action | Input | Used by |
| --- | --- | --- |
| `summary` | Markdown on stdin | the `summary` skill |
| `note`, `clear-notes` | Markdown on stdin | the `note` skill |
| `recap`, `progress`, `headsup`, `commit` | text on stdin | the hooks module |
| `commit-diff <cwd>` | none | the hooks module: prints `{key, text}` of `git diff HEAD` as JSON |
| `tests-touch <cwd>` | JSON list of paths on stdin | the hooks module |
| `tests-result <cwd>` | JSON `{command, output}` on stdin | the hooks module |
| `tests-proposed` | JSON list of names on stdin | the hooks module |
| `tests-run <cwd> [command] [file...]` | none | the hooks module: each turn end, and `rerun` |
| `data` | none | the hooks module: prints all panel data as JSON |
| `open`, `close`, `status`, `hook` | none | cmux mode, `/panel` |

The session defaults to `$CLAUDE_CODE_SESSION_ID`.

## State files

All in `~/.claude/tools/chat-panel/state/`, one set for each session id:

| File | Holds | Writer |
| --- | --- | --- |
| `<session>.summary.md` | the last summary | `control.py summary` |
| `<session>.notes.md` | the notes, oldest first | `control.py note` |
| `<session>.recaps.jsonl` | one recap for each answered turn | `control.py recap` |
| `<session>.commit.md` | the last draft commit message | `control.py commit` |
| `<session>.progress.md` | the checklist, one `[x]` / `[>]` / `[ ]` line per item | `control.py progress` |
| `<session>.tests.json` | the test files, their results, the proposed tests, the running rerun | `tests_tracker.py` |
| `<session>.headline.json` | the last live headline | `panel.read_ysk_headline()` |
| `<session>.headsup.json` | the last generated heads-up | `control.py headsup` |
| `<session>.pid`, `<session>.where` | the cmux / tmux pane process | `control.py open` |

## Files

| File | Holds |
| --- | --- |
| `hooks/register.tsx` | the hooks, the poll, the `/panel` command, the native pane |
| `hooks/data.ts` | pure functions and prompts: labels, prompts, reply parsers, throttle, turn buffer |
| `hooks/register.test.tsx` | tests of `hooks/data.ts` and of the pane before its first poll |
| `types/index.d.ts` | `PanelData` and the `$.state` contract |
| `~/.claude/tools/chat-panel/control.py` | the actions above; `panel_data()` collects all panel data |
| `~/.claude/tools/chat-panel/panel.py` | the cmux / tmux pane and the readers of the state files |
| `~/.claude/tools/chat-panel/tests_tracker.py` | the Tests state: touch, parse, rerun, view |
| `~/.claude/tools/chat-panel/test_tests_tracker.py` | tests of `tests_tracker.py` |

Some values exist twice, once for each pane, and must agree: `isTestPath()` and `is_test_path()`,
`TEST_MARKS` and `STATUS_MARKS`, `testCounts()` and `counts_text()`.

## Development

The session loads the mod from `CLAUDE_CODE_PLUGIN_DIRS` (set in `~/.zshrc`) and reloads it when a file
of it is saved.

Check a change with these commands:

```bash
M=~/.claude/skills/chat-panel
claude plugin validate $M                      # hooks, calls and state keys the engine accepts
claude plugin test $M                          # hooks/register.test.tsx
npx -y -p typescript tsc -p $M --noEmit        # types; the engine lays them in .claude-plugin/types/
cd ~/.claude/tools/chat-panel && uvx --with pytest pytest test_tests_tracker.py -q -p no:cacheprovider
```

Run the commands from outside the mod folder, so that the folder gets no extra files.

If a hook fails, the transcript shows a dim `chat-panel: ...` line, and the debug log gets the detail.
The poll logs its own failures with `$.ui.log(..., { to: 'debug' })`.

## Limits

- The Progress checklist comes from tool labels and visible text. The model's reasoning is not
  readable: the stored thinking blocks hold a signature and no text.
- Each answered turn costs up to four haiku calls: recap, progress, a commit draft when the diff
  changed and, for an answer that mentions tests, proposed tests. A long turn adds about one progress
  call for each minute.
- The Tests section tracks pytest files only. A pytest run in the background is not parsed.
- The pane has no tabs. Each section is a block in one column.
- No test draws the pane with data: the test kit cannot seed `$.state`. A tree the engine refuses
  shows as a dim `chat-panel: ui.render (Pane) refused` line in the transcript.
