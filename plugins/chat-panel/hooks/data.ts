import type { PanelData, PendingTurn, TurnBuffer } from '../types'

/**
 * Parses the JSON that `control.py data` prints.
 * :param text: stdout of `control.py data`
 * :return: the panel data, or null when the text is not valid
 */
export const parseData = (text: string): PanelData | null => {
  try {
    const d = JSON.parse(text) as PanelData
    return Array.isArray(d.recaps) ? d : null
  } catch {
    return null
  }
}

/**
 * Whether two polls carry the same content, so an unchanged poll does not redraw the pane.
 */
export const sameData = (a: PanelData | null, b: PanelData): boolean => a !== null && JSON.stringify(a) === JSON.stringify(b)

/** The system prompt for the per-turn recap. */
export const RECAP_SYSTEM =
  'You write the one-line recap shown in a side panel of a coding session. ' +
  "Given the previous recap and the assistant's latest answer, write ONE or TWO short sentences: " +
  'what is going on now, then "Next:" and the next step or what the user must decide. ' +
  'Plain text, no markdown, no preamble, at most 300 characters.'

const ANSWER_CHARS = 6000

/**
 * The prompt for the per-turn recap: the previous recap, then the latest answer cut to its last part.
 * :param previous: the newest recap the panel shows, or undefined
 * :param answer: the assistant's final text of the turn
 */
export const recapPrompt = (previous: string | undefined, answer: string): string =>
  `<previous_recap>\n${previous ?? '(none)'}\n</previous_recap>\n\n` +
  `<latest_answer>\n${answer.length > ANSWER_CHARS ? '…' + answer.slice(-ANSWER_CHARS) : answer}\n</latest_answer>`

/**
 * Whether a finished turn earns a recap: an answered main-loop turn with visible text.
 */
export const shouldRecap = (e: { reason: string; answer: string; agentId?: string }): boolean =>
  e.reason === 'answer' && e.agentId === undefined && e.answer.trim().length > 0

/** The reply that means "leave the checklist as it is". */
export const UNCHANGED = 'UNCHANGED'

const TOOLS_SHOWN = 40
const TURN_TEXT_CHARS = 4000
/** The shortest gap between two checklist refreshes while a turn runs. */
export const MID_TURN_MS = 60000
const LABEL_CHARS = 80

/** The system prompt for the per-turn progress checklist. */
export const PROGRESS_SYSTEM =
  'You maintain the progress checklist shown in a side panel of a coding session. ' +
  'Given the current checklist, the tools the assistant ran this turn, the text it wrote between them ' +
  'and its latest answer ("(turn still running)" while the turn runs), ' +
  'return the updated checklist of the multi-step work in hand. ' +
  'One item per line, each starting with "[x] " (done), "[>] " (in progress) or "[ ] " (to do). ' +
  'Keep existing items and their wording: change statuses and add new steps. ' +
  'Every "[x] " step of the current list stays in the reply, in its place, except a step that a later turn ' +
  'superseded, reversed or dropped (for example a test that was later deleted, or a plan the user rejected): ' +
  'remove that step. When a later turn changes the facts of a step (a count, a place, a name), rewrite its line. ' +
  'Sub-steps belong only to the step in progress. When a step is finished, skipped or rejected, ' +
  'remove only its sub-steps and keep the step itself as one "[x] " line that names its outcome, ' +
  'for example "[x] Site 5: kept as is (skipped)". Keep one line per step: never repeat a step name. ' +
  'A step that the user says is done is "[x] ". ' +
  'A step that the answer only proposes, or that waits for approval, is not done: keep it "[ ] " or "[>] ". ' +
  'Start a new list only when the work moved to a different task. ' +
  `Each item at most ${LABEL_CHARS} characters, in order of work. ` +
  'A list of findings or proposed changes from a code review, /code-review, /simplify or a similar audit ' +
  '(in the answer or as "finding: " tool lines) is multi-step work: add one "[ ] " item per finding, ' +
  'even when no other tool ran. A later turn that fixes, skips or rejects a finding marks it "[x] ". ' +
  'A finding is something the answer reports that is not work the assistant does next: a bug found outside the ' +
  'task, a gap, a risk, a blocker, an open question. Write each finding as one "[i] " line, after all the steps. ' +
  'Remove a finding when it is resolved or the user dismisses it; when the user asks to act on it, replace it ' +
  'with a step. ' +
  'A list of options, ideas, alternatives or possible causes to choose from (/options) is a discussion, ' +
  'not multi-step work: add no items for it. ' +
  'Record only steps that the tools or the answer show; do not invent steps. ' +
  `If the turn was a question or a discussion, or it changes no item, reply with exactly ${UNCHANGED}. ` +
  'Plain text, no markdown, no preamble.'

/**
 * A short label for one tool call: the tool, then its description or the file it names.
 * :param e: the tool.call input, the tool's arguments beside `tool`
 */
export const toolLabel = (e: { tool: string; description?: unknown; file_path?: unknown; skill?: unknown; pattern?: unknown }): string => {
  const file = typeof e.file_path === 'string' ? e.file_path.split('/').pop() : undefined
  const detail = [e.description, file, e.skill, e.pattern].find(v => typeof v === 'string' && v.trim().length > 0) as string | undefined
  return (detail ? `${e.tool}: ${detail.trim()}` : e.tool).slice(0, LABEL_CHARS)
}

/**
 * One label per finding of a ReportFindings call, so the progress checklist can list them; none for other tools.
 * :param e: the tool.call input, the tool's arguments beside `tool`
 */
export const findingLabels = (e: { tool: string; findings?: unknown }): string[] => {
  if (e.tool !== 'ReportFindings' || !Array.isArray(e.findings)) return []
  return e.findings.flatMap(f => {
    const text = [f?.short_summary, f?.summary].find(v => typeof v === 'string' && v.trim().length > 0) as string | undefined
    return text ? [`finding: ${text.trim()}`.slice(0, LABEL_CHARS)] : []
  })
}

/**
 * The visible text of one response row: its text blocks joined, thinking and tool calls left out.
 * :param content: the row's content blocks
 */
export const responseText = (content: readonly { type: string; text?: unknown }[]): string =>
  content.flatMap(b => (b.type === 'text' && typeof b.text === 'string' && b.text.trim() ? [b.text.trim()] : [])).join('\n')

/**
 * Whether a running turn earns a checklist refresh now: new text since the last refresh, and the gap has passed.
 * :param now: the clock, in milliseconds
 * :param lastAt: when the checklist was last refreshed, in milliseconds
 * :param hasNewText: whether the turn wrote text since the last refresh
 */
export const shouldRefreshMidTurn = (now: number, lastAt: number, hasNewText: boolean): boolean =>
  hasNewText && now - lastAt >= MID_TURN_MS

/**
 * The prompt for the progress checklist: the current list, the turn's tool calls, its text between them, then the answer.
 * :param previous: the checklist the panel shows, or undefined
 * :param answer: the assistant's final text of the turn, or "" while the turn runs
 * :param tools: the labels of the tools the main loop ran this turn, oldest first
 * :param texts: the text the assistant wrote between tool calls this turn, oldest first
 */
export const progressPrompt = (previous: string | undefined, answer: string, tools: string[], texts: string[] = []): string => {
  const said = texts.filter(t => t !== answer.trim()).join('\n---\n')
  const shown = said.length > TURN_TEXT_CHARS ? '…' + said.slice(-TURN_TEXT_CHARS) : said
  return `<current_checklist>\n${previous ?? '(none)'}\n</current_checklist>\n\n` +
    `<tools_this_turn>\n${tools.length ? tools.slice(-TOOLS_SHOWN).join('\n') : '(none)'}\n</tools_this_turn>\n\n` +
    `<text_this_turn>\n${shown || '(none)'}\n</text_this_turn>\n\n` +
    `<latest_answer>\n${answer.length > ANSWER_CHARS ? '…' + answer.slice(-ANSWER_CHARS) : answer || '(turn still running)'}\n</latest_answer>`
}

/**
 * The checklist in a model reply, or null when the reply keeps the current one.
 * :param reply: the model's text
 * :return: the `[x] ` / `[>] ` / `[ ] ` lines, or null for UNCHANGED or a reply with no item
 */
export const parseProgress = (reply: string): string | null => {
  if (reply.trim() === UNCHANGED) return null
  // A model often writes a markdown task list (`- [X] ...`, `* [~] ...`) whatever the prompt says.
  const items = reply.split('\n').flatMap(line => {
    const item = /^[-*]?\s*\[([xX>~ iI!-])\]\s+(\S.*)$/.exec(line.trim())
    if (!item) return []
    const mark = (item[1] ?? ' ').toLowerCase()
    return [`[${mark === '~' || mark === '-' ? '>' : mark === '!' ? 'i' : mark}] ${item[2]}`]
  })
  // Findings go after all the steps, so the panel shows them as one section.
  const ordered = [...items.filter(line => !line.startsWith('[i] ')), ...items.filter(line => line.startsWith('[i] '))]
  return ordered.length ? ordered.join('\n') : null
}

/** The system prompt that merges the done items of the checklist into fewer items. */
export const COMPACT_SYSTEM =
  'You compact the done items of a progress checklist. Merge related items into fewer, broader items, so that the ' +
  'list is at most half as long. Keep each fact that matters: file names, decisions, results. Each item is one short ' +
  'line in the past tense. Reply with the items only, one per line, each starting with "[x] ", in the original order.'

/**
 * The done items of a checklist.
 * :param text: the checklist, one `[x] ` / `[>] ` / `[ ] ` line per item
 */
export const doneItems = (text: string): string[] => text.split('\n').filter(line => line.startsWith('[x] '))

/**
 * The checklist with its done items replaced by the compacted ones, at the place of the first done item.
 * The items that are not done keep their text and their order.
 * :param text: the checklist
 * :param reply: haiku's reply to COMPACT_SYSTEM
 * :return: the new checklist, or null when the reply has no done item or is not shorter
 */
export const compactChecklist = (text: string, reply: string): string | null => {
  const done = doneItems(text)
  const merged = (parseProgress(reply) ?? '').split('\n').filter(line => line.startsWith('[x] '))
  if (!merged.length || merged.length >= done.length) return null
  const lines = text.split('\n')
  const first = lines.findIndex(line => line.startsWith('[x] '))
  return lines.flatMap((line, i) => (i === first ? merged : line.startsWith('[x] ') ? [] : [line])).join('\n')
}

/** The most tool labels and text pieces a turn buffer keeps; the oldest go first. */
export const MAX_TURN_ITEMS = 40

/** A turn buffer with nothing in it. */
export const EMPTY_TURN: TurnBuffer = { tools: [], texts: [], hasNewText: false }

/**
 * The turn buffer with tool labels added, the oldest dropped past the limit.
 * :param turn: the buffer
 * :param labels: the labels of one tool call
 */
export const withTools = (turn: TurnBuffer, labels: string[]): TurnBuffer =>
  ({ ...turn, tools: [...turn.tools, ...labels].slice(-MAX_TURN_ITEMS) })

/**
 * The turn buffer with one piece of visible text added and marked new; unchanged for empty text.
 * :param turn: the buffer
 * :param text: the visible text of one response row
 */
export const withText = (turn: TurnBuffer, text: string): TurnBuffer =>
  text ? { tools: turn.tools, texts: [...turn.texts, text].slice(-MAX_TURN_ITEMS), hasNewText: true } : turn

/**
 * The pending turn a finished turn leaves for the poll, or null when it earns no recap.
 * :param turn: the buffer of the turn
 * :param e: the turn.complete input
 */
export const pendingFrom = (turn: TurnBuffer, e: { reason: string; answer: string; agentId?: string }): PendingTurn | null =>
  shouldRecap(e) ? { answer: e.answer, tools: turn.tools, texts: turn.texts } : null

/** Whether a path names a pytest file: test_*.py or *_test.py. Mirrors is_test_path() in tests_tracker.py. */
export const isTestPath = (path: string): boolean => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(path)

/** Whether a Bash command runs pytest. */
export const isPytestCommand = (command: string): boolean => /(^|[\s/;&|])pytest(\s|$)/.test(command)

/** Whether an answer talks about tests, so it is worth asking haiku for proposed tests. */
export const mentionsTests = (answer: string): boolean => /\btests?\b/i.test(answer)

/** The reply that means "no test is proposed". */
export const NONE = 'NONE'

/** The system prompt that finds the tests an answer proposes to write or change. */
export const TESTS_SYSTEM =
  'You read the latest answer of a coding assistant. List the tests it proposes or plans to write or change ' +
  'but has not written yet: one per line, the test function name or test file path, at most 80 characters. ' +
  'Leave out tests it already wrote, ran or changed in this answer. ' +
  `If it proposes none, reply with exactly ${NONE}. Plain text, no markdown, no preamble.`

/**
 * The proposed tests in a model reply.
 * :param reply: the model's text
 * :return: the names, [] for NONE, null for an empty reply
 */
export const parseProposed = (reply: string): string[] | null => {
  if (reply.trim() === NONE) return []
  const names = reply.split('\n').map(l => l.replace(/^[-*•\d.)\s]+/, '').replace(/`/g, '').trim()).filter(l => l && l !== NONE)
  return names.length ? names.slice(0, 10).map(n => n.slice(0, 80)) : null
}

/** The marks of the Tests section, per status. Mirrors STATUS_MARKS in tests_tracker.py. */
export const TEST_MARKS: Record<string, string> = { passed: '✔', failed: '✘', running: '◌', stale: '↻', 'not-run': '?', timeout: '⏱', error: '!' }

/**
 * The result words for one test file. Mirrors counts_text() in tests_tracker.py.
 * :param f: the file's status and counts
 */
export const testCounts = (f: { status: string; passed: number | null; failed: number | null }): string => {
  const words: Record<string, string> = { running: 'running…', 'not-run': 'not run', timeout: 'timed out', error: 'error' }
  if (words[f.status]) return words[f.status] as string
  const parts = [f.passed !== null ? `${f.passed} passed` : '', f.failed ? `${f.failed} failed` : ''].filter(Boolean)
  return (parts.join(' · ') || f.status) + (f.status === 'stale' ? ' (edited since)' : '')
}

/**
 * The prompt that asks the assistant to fix a test file's failing tests.
 * :param path: the test file
 * :param failing: the failing test names the panel knows
 */
export const fixPrompt = (path: string, failing: string[]): string =>
  failing.length ? `Fix the failing tests in ${path}: ${failing.join(', ')}.` : `Fix the failing tests in ${path}.`

/** The prompt that asks the assistant to write a proposed test. */
export const writePrompt = (name: string): string => `Write the proposed test ${name}.`

/** The prompt that asks the assistant to go on with a checklist item. */
export const continuePrompt = (item: string): string => `Continue with: ${item}`

/** The item text of a checklist line, without its `[x] ` / `[>] ` / `[ ] ` / `[i] ` mark. */
export const itemText = (line: string): string => line.replace(/^\[[x> i]\] /, '')

/**
 * The checklist with one item marked done or removed.
 * :param text: the checklist, one `[x] ` / `[>] ` / `[ ] ` line per item
 * :param index: the item, from 0
 * :param action: "done" or "remove"; "done" removes a finding, which has no done state
 * :return: the new checklist; "" when the last item goes
 */
export const changeItem = (text: string, index: number, action: 'done' | 'remove'): string =>
  text.split('\n').flatMap((line, i) => (
    i !== index ? [line] : action === 'remove' || line.startsWith('[i] ') ? [] : [`[x] ${itemText(line)}`]
  )).join('\n')

/** The pane's help: one line for each section and control. Focus: click the pane or press ctrl+x tab. */
export const HELP = [
  'Focus the pane: click it or ctrl+x tab. Esc: back to the prompt.',
  '⚑ Heads up: what to know now. generate (h): haiku writes one.',
  '≡ Summary: the last /summary. /summary (s): run it.',
  '✉ Draft commit message: redrafted from git diff HEAD at turn end when the diff changes.',
  '  generate from diff (g), generate from chat (t): draft now; commit (m): fill the prompt box.',
  '☑ Progress: the steps of the work, then ⓘ Findings. Item: pick one; done (d), remove (x),',
  '  continue (n): put "Continue with: <item>" in the prompt box. compact (k): merge the done items.',
  '⚗ Tests: touched pytest files, rerun at each turn end. rerun: run a file now;',
  '  fix / write: put a prompt in the prompt box.',
  '✎ Notes: saved with /note. clear (c): delete them.',
  '↺ Recaps: the last 3 recaps. /recap (p): run it.',
  'Prompt buttons fill the prompt box and never send. /panel opens or closes the pane.',
]

/** The format rules of a draft commit message. */
const COMMIT_FORMAT =
  'First line: the ticket id when one is given, a space, then an imperative summary in sentence case, at most 72 ' +
  'characters in all, no full stop (example: "PROJ-123 Update the report check"). If the change has more than one ' +
  'part, add a blank line and up to 5 lines that start with "- ", one for each main change. British spelling. ' +
  'Plain text only: no code fences, no preamble, no trailer.'

/** The system prompt for a draft commit message from the diff. */
export const COMMIT_SYSTEM = 'You write a draft git commit message for the diff. ' + COMMIT_FORMAT

/** The system prompt for a draft commit message from the chat session. */
export const COMMIT_CHAT_SYSTEM =
  'You write a draft git commit message for the code changes made in a coding session, from the session notes: ' +
  'the checklist, the summary, the recaps and the last answer. Describe only changes that were made, not plans, ' +
  'questions or discussion. ' + COMMIT_FORMAT

/**
 * The prompt for a draft commit message from the chat session.
 * :param branch: the git branch
 * :param notes: the checklist, the summary, the recaps and the last answer; absent ones are left out
 */
export const commitChatPrompt = (
  branch: string,
  notes: { progress?: string; summary?: string; recaps: string[]; answer?: string },
): string =>
  [
    `<ticket>${ticketOf(branch) || '(none)'}</ticket>\n<branch>${branch || '(unknown)'}</branch>`,
    notes.progress && `<checklist>\n${notes.progress}\n</checklist>`,
    notes.summary && `<summary>\n${notes.summary}\n</summary>`,
    notes.recaps.length > 0 && `<recaps>\n${notes.recaps.join('\n')}\n</recaps>`,
    notes.answer && `<last_answer>\n${notes.answer.length > ANSWER_CHARS ? '…' + notes.answer.slice(-ANSWER_CHARS) : notes.answer}\n</last_answer>`,
  ].filter(Boolean).join('\n\n')

/**
 * The ticket id in a branch name, such as PROJ-123 in "user/PROJ-123-new-feature".
 * :param branch: the git branch
 * :return: the ticket id, or "" when the branch has none
 */
export const ticketOf = (branch: string): string => branch.match(/\b([A-Z][A-Z0-9]+-\d+)(?!\d)/)?.[1] ?? ''

/**
 * The prompt for a draft commit message: the ticket, the branch and the diff.
 * :param branch: the git branch
 * :param diff: the stat and the diff against HEAD
 */
export const commitDraftPrompt = (branch: string, diff: string): string =>
  `<ticket>${ticketOf(branch) || '(none)'}</ticket>\n<branch>${branch || '(unknown)'}</branch>\n\n<diff>\n${diff}\n</diff>`

/**
 * The output of `control.py commit-diff`.
 * :param text: its stdout
 * :return: {key, text}, or null with no change, no repository or broken output
 */
export const parseDiff = (text: string): { key: string; text: string } | null => {
  try {
    const diff = JSON.parse(text) as { key?: unknown; text?: unknown }
    return typeof diff.key === 'string' && diff.key && typeof diff.text === 'string' ? { key: diff.key, text: diff.text } : null
  } catch {
    return null
  }
}

/**
 * A commit message reply without code fences or blank edges.
 * :param reply: haiku's reply
 */
export const commitText = (reply: string): string => reply.split('\n').filter(line => !line.trim().startsWith('```')).join('\n').trim()

/**
 * The prompt that asks for a commit with the draft message.
 * :param message: the draft commit message
 */
export const commitWithPrompt = (message: string): string => `Commit the staged and changed files with this message:\n\n${message}`

/** The system prompt for a heads-up the person asks for. */
export const HEADSUP_SYSTEM =
  'You write the "heads up" line of a side panel in a coding session: the ONE thing the user should know now ' +
  'and could miss. Look for a risk, a failing test, a decision that waits for them, or a step that was skipped. ' +
  'If nothing stands out, say what to do next. One sentence, at most 160 characters, plain text, no preamble.'

/**
 * The prompt for a heads-up: the latest answer, the checklist and the test lines.
 * :param answer: the assistant's last answer, or undefined
 * :param progress: the checklist, or undefined
 * :param tests: one line per test file
 */
export const headsupPrompt = (answer: string | undefined, progress: string | undefined, tests: string[]): string =>
  `<latest_answer>\n${answer ? (answer.length > ANSWER_CHARS ? '…' + answer.slice(-ANSWER_CHARS) : answer) : '(none)'}\n</latest_answer>\n\n` +
  `<checklist>\n${progress ?? '(none)'}\n</checklist>\n\n` +
  `<tests>\n${tests.length ? tests.join('\n') : '(none)'}\n</tests>`
