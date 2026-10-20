import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PanelData, PendingTurn, TurnBuffer } from '../types'

import { changeItem, COMMIT_CHAT_SYSTEM, COMMIT_SYSTEM, commitChatPrompt, compactChecklist, COMPACT_SYSTEM, commitDraftPrompt, commitText, commitWithPrompt, continuePrompt, doneItems, EMPTY_TURN, findingLabels, fixPrompt, HELP, HEADSUP_SYSTEM, headsupPrompt, isPytestCommand, isTestPath, itemText, mentionsTests, parseData, parseProgress, parseProposed, parseDiff, pendingFrom, PROGRESS_SYSTEM, progressPrompt, RECAP_SYSTEM, recapPrompt, responseText, sameData, shouldRecap, shouldRefreshMidTurn, TEST_MARKS, testCounts, TESTS_SYSTEM, toolLabel, withText, withTools, writePrompt } from './data'

const PANE = 'chat-panel'
const TITLE = 'Chat'
const POLL_MS = 2000
const dataAtom = atom({ plugin: 'chat-panel', key: 'data' } as const, null as PanelData | null)
// The running turn and the finished one live in $.state, so a reload of the mod (a save of its files) keeps them.
const turnAtom = atom({ plugin: 'chat-panel', key: 'turn' } as const, EMPTY_TURN as TurnBuffer)
const pendingAtom = atom({ plugin: 'chat-panel', key: 'pending' } as const, null as PendingTurn | null)
// The last finished turn, for a heads-up the person asks for; the checklist item the Progress select points at.
const lastAtom = atom({ plugin: 'chat-panel', key: 'last' } as const, null as PendingTurn | null)
const selectedAtom = atom({ plugin: 'chat-panel', key: 'selected' } as const, 0)
// The hash of the diff the draft commit message was made from: no new haiku call while the diff stays the same.
const commitKeyAtom = atom({ plugin: 'chat-panel', key: 'commitKey' } as const, '')
// Whether the pane shows its help.
const helpAtom = atom({ plugin: 'chat-panel', key: 'help' } as const, false)

/**
 * Runs ~/.claude/tools/chat-panel/control.py with an action and this session's id.
 * :param $: engine
 * :param action: data, open, close, status or recap
 * :param stdin: text for the action's standard input (recap)
 * :return: the process result
 */
async function control($: EngineInterface, action: string, stdin?: string, args: string[] = [], timeoutMs = 15000) {
  const home = await $.env.get('HOME')
  const sessionId = await $.session.id()
  return $.process.run(['python3', `${home}/.claude/tools/chat-panel/control.py`, action, sessionId, ...args], { timeoutMs, stdin })
}

/**
 * Asks haiku which tests the answer proposes to write or change, and shows them in the Tests section.
 * :param $: engine
 * :param answer: the assistant's final text of the turn
 */
async function addProposedTests($: EngineInterface, answer: string) {
  const reply = await $.model.complete({ model: 'haiku', system: TESTS_SYSTEM, prompt: answer.slice(-6000), maxTokens: 300, timeoutMs: 30000 })
  const names = reply.isAnswered ? parseProposed(reply.text) : null
  if (names) await control($, 'tests-proposed', JSON.stringify(names))
}

/**
 * Asks haiku for a one-line recap of the latest answer and adds it to the panel's recaps.
 * :param $: engine
 * :param answer: the assistant's final text of the turn
 */
async function addRecap($: EngineInterface, answer: string) {
  const previous = (await read($, dataAtom))?.recaps[0]?.text
  const reply = await $.model.complete({
    model: 'haiku', system: RECAP_SYSTEM, prompt: recapPrompt(previous, answer), maxTokens: 200, timeoutMs: 30000,
  })
  if (reply.isAnswered && reply.text.trim()) await control($, 'recap', reply.text.trim())
}

/**
 * Asks haiku for the checklist of the multi-step work after a turn and stores it, unless the turn changed nothing.
 * :param $: engine
 * :param answer: the assistant's final text of the turn
 * :param tools: the labels of the tools the main loop ran this turn
 * :param texts: the text the assistant wrote between tool calls this turn
 */
async function addProgress($: EngineInterface, answer: string, tools: string[], texts: string[]) {
  const previous = (await read($, dataAtom))?.progress?.text
  const reply = await $.model.complete({
    model: 'haiku', system: PROGRESS_SYSTEM, prompt: progressPrompt(previous, answer, tools, texts), maxTokens: 1500, timeoutMs: 30000,
  })
  const progress = reply.isAnswered ? parseProgress(reply.text) : null
  if (progress && progress !== previous) await control($, 'progress', progress)
}

/**
 * Drafts a commit message from the changes against HEAD and shows it in the panel.
 * :param $: engine
 * :param isForced: draft again even when the diff is the one of the current draft
 * :return: what happened, for a toast
 */
async function draftCommit($: EngineInterface, isForced: boolean): Promise<string> {
  const cwd = await $.session.cwd()
  const diff = parseDiff((await control($, 'commit-diff', undefined, [cwd], 30000)).stdout)
  if (!diff) return 'No changes against HEAD.'
  if (!isForced && diff.key === (await read($, commitKeyAtom))) return 'The draft is up to date.'
  const reply = await $.model.complete({
    model: 'haiku', system: COMMIT_SYSTEM, prompt: commitDraftPrompt((await read($, dataAtom))?.branch ?? '', diff.text),
    maxTokens: 400, timeoutMs: 30000,
  })
  const text = reply.isAnswered ? commitText(reply.text) : ''
  if (!text) return 'No draft came back.'
  await control($, 'commit', text)
  await update($, commitKeyAtom, () => diff.key)
  return 'Draft commit message updated.'
}

/**
 * Test runs going now: the assistant's own pytest runs, and whether a run of the mod is going.
 * Module state, not $.state: a reload ends the runs it counts.
 */
const runs = { own: 0, isTesting: false }

/**
 * Runs one control of the pane and tells the person how it went in a toast.
 * :param $: engine
 * :param name: what the toast calls the action
 * :param action: the work; its string, when it returns one, is the toast
 * :param startText: a toast to show before the work starts, for slow work
 */
function act($: EngineInterface, name: string, action: () => Promise<string | void>, startText?: string) {
  if (startText) $.ui.toast(startText)
  void action()
    .then(text => $.ui.toast(text || `${name}: done`))
    .catch(err => {
      $.ui.toast(`${name} failed`)
      $.ui.log(`chat-panel: ${name} failed: ${String(err)}`, { to: 'debug' })
    })
}

/**
 * Reruns one test file now, changed or not, unless a run is going.
 * :param $: engine
 * :param path: the test file, relative to the session's directory
 * :param command: the pytest command before the file names
 */
function rerunFile($: EngineInterface, path: string, command: string) {
  act($, 'Rerun', async () => {
    if (runs.isTesting || runs.own > 0) return 'A test run is going; try again when it ends.'
    runs.isTesting = true
    $.ui.toast(`Running ${path}…`)
    try {
      const cwd = await $.session.cwd()
      const result = await control($, 'tests-run', undefined, [cwd, command, path], 330000)
      return result.stdout.trim() || result.stderr.trim()
    } finally {
      runs.isTesting = false
    }
  })
}

/**
 * Puts a prompt in the prompt box for the person to edit and send.
 * :param $: engine
 * :param text: the prompt
 */
function fillPrompt($: EngineInterface, text: string) {
  act($, 'Prompt', async () => {
    const filled = await $.prompt.fill({ text })
    return filled.isFilled ? 'Prompt box filled: edit it and press Enter.' : 'The prompt box is busy; try again.'
  })
}

/**
 * Marks the selected checklist item done, or removes it.
 * :param $: engine
 * :param action: "done" or "remove"
 */
function changeSelected($: EngineInterface, action: 'done' | 'remove') {
  act($, 'Progress', async () => {
    const text = (await read($, dataAtom))?.progress?.text
    if (!text) return 'No checklist.'
    const changed = changeItem(text, await read($, selectedAtom), action)
    await control($, 'progress', changed, changed ? [] : ['--allow-empty'])
    await update($, selectedAtom, () => 0)
    return action === 'done' ? 'Item marked done.' : 'Item removed.'
  })
}

/**
 * Asks haiku to merge the done items of the checklist into fewer items, and stores the shorter checklist.
 * :param $: engine
 */
function compactProgress($: EngineInterface) {
  act($, 'Compact', async () => {
    const text = (await read($, dataAtom))?.progress?.text
    const done = text ? doneItems(text) : []
    if (!text || done.length < 2) return 'Fewer than 2 done items: nothing to compact.'
    const reply = await $.model.complete({ model: 'haiku', system: COMPACT_SYSTEM, prompt: done.join('\n'), maxTokens: 1500, timeoutMs: 30000 })
    const compacted = reply.isAnswered ? compactChecklist(text, reply.text) : null
    if (!compacted) return 'No shorter list came back.'
    await control($, 'progress', compacted)
    await update($, selectedAtom, () => 0)
    return `Done items: ${done.length} → ${doneItems(compacted).length}.`
  }, 'Compacting the done items…')
}

/**
 * Runs a slash command the way the person would type it; a /recap's text joins the panel's recaps.
 * :param $: engine
 * :param command: the command name, without its slash
 */
function runCommand($: EngineInterface, command: string) {
  act($, `/${command}`, async () => {
    const result = await $.command.run({ command })
    if (command === 'recap' && result.text?.trim()) await control($, 'recap', result.text.trim())
    return command === 'summary' ? 'Summary requested: it shows when the turn ends.' : `/${command} ran.`
  })
}

/**
 * Asks haiku for a heads-up from the last answer, the checklist and the tests, and shows it.
 * :param $: engine
 */
function headsUp($: EngineInterface) {
  act($, 'Heads up', async () => {
    const d = await read($, dataAtom)
    const last = await read($, lastAtom)
    const tests = (d?.tests?.files ?? []).map(f => `${f.path}: ${testCounts(f)}${f.failing.length ? ` (${f.failing.join(', ')})` : ''}`)
    const reply = await $.model.complete({
      model: 'haiku', system: HEADSUP_SYSTEM, prompt: headsupPrompt(last?.answer, d?.progress?.text, tests), maxTokens: 200, timeoutMs: 30000,
    })
    if (!reply.isAnswered || !reply.text.trim()) return 'No heads-up came back.'
    await control($, 'headsup', reply.text.trim())
    return 'Heads-up updated.'
  }, 'Writing a heads-up…')
}

/**
 * Drafts the commit message now, from the current diff.
 * :param $: engine
 */
function generateCommit($: EngineInterface) {
  act($, 'Commit draft', () => draftCommit($, true), 'Drafting a commit message from the diff…')
}

/**
 * Drafts the commit message now, from the chat session: the checklist, the summary, the recaps and the last answer.
 * Cheap and small whatever the size of the diff; it misses changes the session does not mention.
 * :param $: engine
 */
function generateCommitFromChat($: EngineInterface) {
  act($, 'Commit draft', async () => {
    const d = await read($, dataAtom)
    const last = await read($, lastAtom)
    const notes = { progress: d?.progress?.text, summary: d?.summary?.text, recaps: (d?.recaps ?? []).map(r => r.text), answer: last?.answer }
    if (!notes.progress && !notes.summary && !notes.recaps.length && !notes.answer) return 'Nothing in the session to draft from yet.'
    const reply = await $.model.complete({
      model: 'haiku', system: COMMIT_CHAT_SYSTEM, prompt: commitChatPrompt(d?.branch ?? '', notes), maxTokens: 400, timeoutMs: 30000,
    })
    const text = reply.isAnswered ? commitText(reply.text) : ''
    if (!text) return 'No draft came back.'
    await control($, 'commit', text)
    return 'Draft commit message updated from the chat.'
  }, 'Drafting a commit message from the chat…')
}

/**
 * Shows or hides the pane's help.
 * :param $: engine
 */
function toggleHelp($: EngineInterface) {
  void update($, helpAtom, isShown => !isShown)
}

/**
 * Clears the panel's notes.
 * :param $: engine
 */
function clearNotes($: EngineInterface) {
  act($, 'Notes', async () => (await control($, 'clear-notes')).stdout.trim())
}

/**
 * chat-panel: the you-should-know headline, the /summary text, the progress checklist, the /note notes and the
 * latest /recaps of this session, in a pane. The `mode` option picks where: "native" (default) draws a Claude Code pane;
 * "cmux" opens a cmux (or tmux) split drawn by ~/.claude/tools/chat-panel/panel.py.
 * Both read the same files through ~/.claude/tools/chat-panel/control.py.
 */
export const register: Register = (on, options) => {
  const mode = options.mode === 'cmux' ? 'cmux' : 'native'
  const autoOpen = options.autoOpen !== false
  const testCommand = typeof options.testCommand === 'string' ? options.testCommand.trim() : 'uv run pytest --no-cov'

  // Whether the poll is calling haiku now, and when it last refreshed the checklist; a reload resets both harmlessly.
  let isRecapping = false
  let lastProgressAt = 0

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      const labels = [toolLabel(e as Parameters<typeof toolLabel>[0]), ...findingLabels(e as Parameters<typeof findingLabels>[0])]
      await update($, turnAtom, turn => withTools(turn, labels))
    }
    const isPytest = e.tool === 'Bash' && isPytestCommand(e.command) && !e.run_in_background
    if (isPytest) runs.own++
    let result
    try {
      result = await next(e)
    } finally {
      if (isPytest) runs.own--
    }
    const cwd = await $.session.cwd()
    const edited = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : undefined
    if (edited && isTestPath(edited) && !('deny' in result)) await control($, 'tests-touch', JSON.stringify([edited]), [cwd])
    if (isPytest && e.tool === 'Bash' && 'text' in result && typeof result.text === 'string') {
      await control($, 'tests-result', JSON.stringify({ command: e.command, output: result.text }), [cwd])
    }
    return result
  }).catch(($, e, next) => next(e)) // an observer, not a guard: a failure here must not stop the tool

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const text = responseText(e.message.content as { type: string; text?: unknown }[])
      if (text) await update($, turnAtom, turn => withText(turn, text))
    }
    return result
  }).catch(($, e, next) => next(e)) // an observer: a failure here must not stop the row

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const pending = pendingFrom(await read($, turnAtom), e)
    if (pending) {
      await update($, pendingAtom, () => pending)
      await update($, lastAtom, () => pending)
    }
    await update($, turnAtom, () => EMPTY_TURN)
    if (testCommand && !runs.isTesting && runs.own === 0) {
      runs.isTesting = true
      // Not awaited: the rerun can take minutes; the poll shows "running…" and then the results.
      void $.session.cwd()
        .then(cwd => control($, 'tests-run', undefined, [cwd, testCommand], 330000))
        .catch(err => $.ui.log(`chat-panel: test rerun failed: ${String(err)}`, { to: 'debug' }))
        .finally(() => { runs.isTesting = false })
    }
    return result
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'panel', description: 'Chat side panel: /panel [open|close|status|native|cmux]' })
    const poll = async () => {
      const pending = isRecapping ? null : await read($, pendingAtom)
      if (pending) {
        await update($, pendingAtom, () => null)
        isRecapping = true
        try {
          await addRecap($, pending.answer)
        } catch (err) {
          $.ui.log(`chat-panel: recap failed: ${String(err)}`, { to: 'debug' })
        }
        try {
          await addProgress($, pending.answer, pending.tools, pending.texts)
          lastProgressAt = await $.clock.now()
        } catch (err) {
          $.ui.log(`chat-panel: progress failed: ${String(err)}`, { to: 'debug' })
        }
        try {
          await draftCommit($, false)
        } catch (err) {
          $.ui.log(`chat-panel: commit draft failed: ${String(err)}`, { to: 'debug' })
        }
        try {
          if (mentionsTests(pending.answer)) await addProposedTests($, pending.answer)
        } catch (err) {
          $.ui.log(`chat-panel: proposed tests failed: ${String(err)}`, { to: 'debug' })
        } finally {
          isRecapping = false
        }
      } else if (!isRecapping) {
        const turn = await read($, turnAtom)
        if (shouldRefreshMidTurn(await $.clock.now(), lastProgressAt, turn.hasNewText)) {
          await update($, turnAtom, t => ({ ...t, hasNewText: false }))
          isRecapping = true
          try {
            await addProgress($, '', turn.tools, turn.texts)
            lastProgressAt = await $.clock.now()
          } catch (err) {
            $.ui.log(`chat-panel: mid-turn progress failed: ${String(err)}`, { to: 'debug' })
          } finally {
            isRecapping = false
          }
        }
      }
      const result = await control($, 'data').catch(() => undefined)
      if (!result || result.exitCode !== 0) return
      const fresh = parseData(result.stdout)
      if (!fresh) return
      const current = await read($, dataAtom)
      if (!sameData(current, fresh)) await update($, dataAtom, () => fresh)
    }
    await poll()
    $.clock.every(POLL_MS, poll)
    if (autoOpen) {
      if (mode === 'native') void $.ui.open({ id: PANE, title: TITLE })
      else void control($, 'open')
    }

    return started
  })

  on('command.run', { command: 'panel' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const target = arg === 'native' || arg === 'cmux' ? arg : mode
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      if (mode === 'cmux') await control($, 'close')
      return { text: 'Chat panel closed.' }
    }
    if (arg === 'status') {
      const isNative = (await $.ui.panes()).some(p => p.id === PANE)
      const cmux = await control($, 'status').catch(() => undefined)
      return { text: `mode ${mode} · native pane ${isNative ? 'open' : 'closed'} · cmux split ${cmux?.stdout.trim() ?? '?'}` }
    }
    if (target === 'native') {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'Chat panel opened.' }
    }
    const result = await control($, 'open')
    return { text: result.stdout.trim() || result.stderr.trim() || 'cmux panel requested.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Select = 'Select' in elements ? elements.Select : undefined
    const d = await read($, dataAtom)
    if (!d) return <Text dimColor>Loading…</Text>
    const rule = <Text dimColor>{'─'.repeat(Math.max(10, (e.viewport?.columns ?? 40) - 2))}</Text>
    const items = d.progress ? d.progress.text.split('\n') : []
    const selected = Math.min(await read($, selectedAtom), Math.max(0, items.length - 1))
    const isHelpShown = await read($, helpAtom)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="flex-end">
          <Button key="help" label={isHelpShown ? 'close help' : 'help'} hotkey="i" onPress={() => toggleHelp($)} />
        </Box>
        {isHelpShown && (
          <Box flexDirection="column">
            {HELP.map(line => <Text dimColor>{line}</Text>)}
            {rule}
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          <Text bold color="yellow">⚑ Heads up</Text>
          <Button key="headsup" label="generate" hotkey="h" onPress={() => headsUp($)} />
        </Box>
        {d.headline ? (
          <Box flexDirection="column">
            <Text dimColor>{[d.headline.tag, d.time.headline, d.headline.isLive ? '' : 'dismissed'].filter(Boolean).join(' · ')}</Text>
            <Text dimColor={!d.headline.isLive}>{d.headline.line}</Text>
          </Box>
        ) : (
          <Text dimColor>none yet</Text>
        )}
        {rule}
        <Box flexDirection="row" gap={1}>
          <Text bold color="green">≡ Summary</Text>
          <Button key="summary" label="/summary" hotkey="s" onPress={() => runCommand($, 'summary')} />
        </Box>
        {d.summary ? (
          <Box flexDirection="column">
            <Text dimColor>{d.time.summary}</Text>
            {d.summary.text.split('\n').map(line => <Text>{line.replace(/^[-*] /, '• ').replace(/\*\*/g, '')}</Text>)}
          </Box>
        ) : (
          <Text dimColor>none yet</Text>
        )}
        {rule}
        <Box flexDirection="row" gap={1}>
          <Text bold color="green">✉ Draft commit message</Text>
          <Button key="commit-generate" label="generate from diff" hotkey="g" onPress={() => generateCommit($)} />
          <Button key="commit-generate-chat" label="generate from chat" hotkey="t" onPress={() => generateCommitFromChat($)} />
          {d.commit && <Button key="commit-use" label="commit" hotkey="m" onPress={() => fillPrompt($, commitWithPrompt(d.commit?.text ?? ''))} />}
        </Box>
        {d.commit ? (
          <Box flexDirection="column">
            <Text dimColor>{d.time.commit}</Text>
            {d.commit.text.split('\n').map(line => <Text>{line || ' '}</Text>)}
          </Box>
        ) : (
          <Text dimColor>none yet</Text>
        )}
        {rule}
        {d.progress && (
          <Box flexDirection="column">
            <Text bold color="blue">☑ Progress</Text>
            <Text dimColor>{d.time.progress}</Text>
            {items.map((line, i) => (
              <Box flexDirection="column">
                {line.startsWith('[i] ') && !items[i - 1]?.startsWith('[i] ') && <Text bold color="magenta">ⓘ Findings</Text>}
                <Text dimColor={line.startsWith('[x]')} bold={line.startsWith('[>]')}>
                  {line.replace(/^\[x\] /, '✔ ').replace(/^\[>\] /, '▶ ').replace(/^\[ \] /, '☐ ').replace(/^\[i\] /, '• ')}
                </Text>
              </Box>
            ))}
            {Select && <Select
              key="progress-item"
              label="Item: "
              options={items.map((line, i) => ({ value: String(i), label: itemText(line) }))}
              value={String(selected)}
              onSelect={(value: string) => void update($, selectedAtom, () => Number(value))}
            />}
            <Box flexDirection="row" gap={1}>
              <Button key="progress-done" label="done" hotkey="d" onPress={() => changeSelected($, 'done')} />
              <Button key="progress-remove" label="remove" hotkey="x" onPress={() => changeSelected($, 'remove')} />
              <Button key="progress-continue" label="continue" hotkey="n" onPress={() => fillPrompt($, continuePrompt(itemText(items[selected] ?? '')))} />
              {doneItems(d.progress.text).length > 1 && <Button key="progress-compact" label="compact" hotkey="k" onPress={() => compactProgress($)} />}
            </Box>
            {rule}
          </Box>
        )}
        {d.tests && (d.tests.files.length > 0 || d.tests.proposed.length > 0) && (
          <Box flexDirection="column">
            <Text bold color="red">⚗ Tests</Text>
            {d.tests.files.map(f => (
              <Box flexDirection="column">
                <Text>
                  <Text color={f.status === 'passed' ? 'green' : ['failed', 'error', 'timeout'].includes(f.status) ? 'red' : undefined} dimColor={!['passed', 'failed', 'error', 'timeout'].includes(f.status)}>
                    {TEST_MARKS[f.status] ?? '?'}
                  </Text>
                  {` ${f.path}`}
                </Text>
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>{`  ${testCounts(f)} · ${new Date(f.atMs).toTimeString().slice(0, 5)}`}</Text>
                  {f.status !== 'running' && <Button key={`rerun:${f.path}`} label="rerun" onPress={() => rerunFile($, f.path, testCommand || 'uv run pytest --no-cov')} />}
                  {['failed', 'error'].includes(f.status) && <Button key={`fix:${f.path}`} label="fix" onPress={() => fillPrompt($, fixPrompt(f.path, f.failing))} />}
                </Box>
                {(f.failing.length > 0 || f.moreFailing > 0) && (
                  <Text color="red">{`    ${[...f.failing, ...(f.moreFailing ? [`+${f.moreFailing} more`] : [])].join(' · ')}`}</Text>
                )}
              </Box>
            ))}
            {d.tests.proposed.map(name => (
              <Box flexDirection="row" gap={1}>
                <Text dimColor>{`✎ ${name} (proposed)`}</Text>
                <Button key={`write:${name}`} label="write" onPress={() => fillPrompt($, writePrompt(name))} />
              </Box>
            ))}
            {rule}
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          <Text bold color="magenta">✎ Notes</Text>
          {d.notes && <Button key="notes-clear" label="clear" hotkey="c" onPress={() => clearNotes($)} />}
        </Box>
        {d.notes ? (
          d.notes.text.split('\n').map(line => <Text dimColor={/^\*[^*].*\*$/.test(line)}>{line.replace(/^[-*] /, '• ').replace(/\*\*/g, '')}</Text>)
        ) : (
          <Text dimColor>none yet: save one with /note</Text>
        )}
        {rule}
        <Box flexDirection="row" gap={1}>
          <Text bold color="cyan">↺ Recaps</Text>
          <Button key="recap" label="/recap" hotkey="p" onPress={() => runCommand($, 'recap')} />
        </Box>
        {d.recaps.length === 0 && <Text dimColor>none yet</Text>}
        {d.recaps.map((r, i) => (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>{[d.time.recaps[i], r.source].filter(Boolean).join(' · ')}</Text>
            <Text>{r.text}</Text>
          </Box>
        ))}
        {rule}
        <Text dimColor>{d.branch || '?'}</Text>
      </Box>
    )
  })
}
