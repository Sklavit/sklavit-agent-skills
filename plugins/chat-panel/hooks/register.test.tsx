import { describe, expect, test } from 'claude-code/testing'

import { changeItem, commitChatPrompt, PROGRESS_SYSTEM, commitDraftPrompt, compactChecklist, commitText, commitWithPrompt, continuePrompt, doneItems, EMPTY_TURN, findingLabels, fixPrompt, headsupPrompt, isPytestCommand, isTestPath, itemText, MAX_TURN_ITEMS, mentionsTests, MID_TURN_MS, NONE, parseData, parseDiff, parseProgress, parseProposed, pendingFrom, progressPrompt, recapPrompt, responseText, sameData, shouldRecap, shouldRefreshMidTurn, testCounts, ticketOf, toolLabel, UNCHANGED, withText, withTools, writePrompt } from './data'

const DATA = {
  headline: { tag: 'Heads up', line: 'Check the doc before sharing it.', shownAt: 0, isLive: true },
  summary: null,
  notes: null,
  progress: null,
  recaps: [{ at: '2026-10-09T12:00:00Z', text: 'Benchmark scripts are ready.', source: 'recap' as const }],
  branch: 'main',
  time: { headline: '12:00', summary: '', progress: '', recaps: ['13:00'] },
}

describe('data', () => {
  test('parses control.py output', () => {
    expect(parseData(JSON.stringify(DATA))?.recaps.length).toBe(1)
  })
  test('rejects broken output', () => {
    expect(parseData('not json')).toBe(null)
    expect(parseData('{}')).toBe(null)
  })
  test('compares by content', () => {
    expect(sameData(null, DATA)).toBe(false)
    expect(sameData(JSON.parse(JSON.stringify(DATA)), DATA)).toBe(true)
  })
})

describe('recap', () => {
  test('only answered main-loop turns with text earn a recap', () => {
    expect(shouldRecap({ reason: 'answer', answer: 'Done.' })).toBe(true)
    expect(shouldRecap({ reason: 'aborted', answer: 'Done.' })).toBe(false)
    expect(shouldRecap({ reason: 'answer', answer: '  ' })).toBe(false)
    expect(shouldRecap({ reason: 'answer', answer: 'Done.', agentId: 'a1' })).toBe(false)
  })
  test('prompt carries the previous recap and the tail of a long answer', () => {
    const prompt = recapPrompt('Old recap.', 'x'.repeat(7000) + 'END')
    expect(prompt).toContain('Old recap.')
    expect(prompt).toContain('…')
    expect(prompt.endsWith('END\n</latest_answer>')).toBe(true)
    expect(recapPrompt(undefined, 'Hi')).toContain('(none)')
  })
})

test('pane before the first poll says it is loading on every surface', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'chat-panel', surface, component: 'Pane', props: {} as never, requestId: 'chat-panel', viewport: { columns: 60, rows: 30 } })
    expect(await ui.find({ type: 'Text', text: /Loading/ })).toBeDefined()
    await ui.unmount()
  }
})

describe('progress', () => {
  test('a tool label names the tool and its description or file', () => {
    expect(toolLabel({ tool: 'Bash', description: 'Run the unit tests' })).toBe('Bash: Run the unit tests')
    expect(toolLabel({ tool: 'Edit', file_path: '/repo/src/api/routes.py' })).toBe('Edit: routes.py')
    expect(toolLabel({ tool: 'ToolSearch' })).toBe('ToolSearch')
    expect(toolLabel({ tool: 'Bash', description: 'x'.repeat(200) }).length).toBe(80)
  })
  test('prompt carries the current checklist, the last tools and the tail of a long answer', () => {
    const tools = Array.from({ length: 45 }, (_, i) => `Bash: step ${i}`)
    const prompt = progressPrompt('[>] Write the fix', 'x'.repeat(7000) + 'END', tools)
    expect(prompt.includes('[>] Write the fix')).toBe(true)
    expect(prompt.includes('Bash: step 44')).toBe(true)
    expect(prompt.includes('Bash: step 4\n')).toBe(false)
    expect(prompt.endsWith('END\n</latest_answer>')).toBe(true)
    expect(progressPrompt(undefined, 'Hi', []).includes('<current_checklist>\n(none)')).toBe(true)
    expect(progressPrompt(undefined, 'Hi', []).includes('<tools_this_turn>\n(none)')).toBe(true)
  })
  test('a reply gives all its checklist lines and nothing else', () => {
    expect(parseProgress('Here it is:\n[x] Read the mod\n  [>] Write the hook\n[ ] Run the tests\n')).toBe('[x] Read the mod\n[>] Write the hook\n[ ] Run the tests')
    expect(parseProgress(Array.from({ length: 12 }, (_, i) => `[ ] step ${i}`).join('\n'))?.split('\n').length).toBe(12)
  })
  test('each ReportFindings finding becomes a label; other tools give none', () => {
    const e = { tool: 'ReportFindings', findings: [{ short_summary: 'Stray ) breaks spans', summary: 'long' }, { summary: 'No short one' }, {}] }
    expect(findingLabels(e)).toEqual(['finding: Stray ) breaks spans', 'finding: No short one'])
    expect(findingLabels({ tool: 'Bash', findings: [{ summary: 'x' }] })).toEqual([])
  })
  test('a markdown task list reads as the same checklist', () => {
    expect(parseProgress('- [X] Read the mod\n* [~] Write the hook\n- [ ] Run the tests')).toBe('[x] Read the mod\n[>] Write the hook\n[ ] Run the tests')
  })
  test('findings read as "[i] " lines after all the steps', () => {
    expect(parseProgress('[i] Harness broken on master\n[x] Add the rule\n[!] Recommendation not in the report\n[ ] Commit'))
      .toBe('[x] Add the rule\n[ ] Commit\n[i] Harness broken on master\n[i] Recommendation not in the report')
  })
  test('the prompt lets a superseded step go and keeps findings apart from steps', () => {
    expect(PROGRESS_SYSTEM.includes('Never remove a top-level step')).toBe(false)
    expect(PROGRESS_SYSTEM.includes('superseded')).toBe(true)
    expect(PROGRESS_SYSTEM.includes('"[i] "')).toBe(true)
  })
  test('an unchanged or item-less reply keeps the current checklist', () => {
    expect(parseProgress(UNCHANGED)).toBe(null)
    expect(parseProgress(` ${UNCHANGED}\n`)).toBe(null)
    expect(parseProgress('Nothing to track.')).toBe(null)
  })
})

describe('mid-turn progress', () => {
  test('a response row gives its visible text only', () => {
    const content = [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: ' Building the panel now. ' },
      { type: 'tool_use', name: 'Bash' },
      { type: 'text', text: '  ' },
    ]
    expect(responseText(content)).toBe('Building the panel now.')
    expect(responseText([{ type: 'tool_use' }])).toBe('')
  })
  test('a running turn refreshes only with new text and after the gap', () => {
    expect(shouldRefreshMidTurn(MID_TURN_MS, 0, true)).toBe(true)
    expect(shouldRefreshMidTurn(MID_TURN_MS - 1, 0, true)).toBe(false)
    expect(shouldRefreshMidTurn(MID_TURN_MS * 5, 0, false)).toBe(false)
  })
  test('prompt carries the mid-turn text without repeating the answer', () => {
    const prompt = progressPrompt('[>] Write the hook', 'Done.', [], ['Reading the types.', 'Done.'])
    expect(prompt.includes('<text_this_turn>\nReading the types.\n</text_this_turn>')).toBe(true)
    expect(progressPrompt(undefined, '', [], ['Step 1.']).includes('(turn still running)')).toBe(true)
    expect(progressPrompt(undefined, 'Hi', []).includes('<text_this_turn>\n(none)')).toBe(true)
  })
})

describe('turn buffer', () => {
  test('tool labels and text add up, the oldest dropped past the limit', () => {
    let turn = withTools(EMPTY_TURN, ['Bash: a', 'finding: b'])
    turn = withText(turn, 'Reading the types.')
    expect(turn).toEqual({ tools: ['Bash: a', 'finding: b'], texts: ['Reading the types.'], hasNewText: true })
    expect(withText(EMPTY_TURN, '')).toBe(EMPTY_TURN)
    const full = withTools(EMPTY_TURN, Array.from({ length: MAX_TURN_ITEMS + 5 }, (_, i) => `t${i}`))
    expect(full.tools.length).toBe(MAX_TURN_ITEMS)
    expect(full.tools[0]).toBe('t5')
  })
  test('a finished turn leaves a pending turn only when it earns a recap', () => {
    const turn = withText(withTools(EMPTY_TURN, ['Edit: data.ts']), 'Writing the fix.')
    expect(pendingFrom(turn, { reason: 'answer', answer: 'Done.' })).toEqual({ answer: 'Done.', tools: ['Edit: data.ts'], texts: ['Writing the fix.'] })
    expect(pendingFrom(turn, { reason: 'aborted', answer: 'Done.' })).toBe(null)
  })
})

describe('tests section', () => {
  test('test paths match pytest files only', () => {
    expect(isTestPath('/repo/tests/unit_tests/api/test_auth.py')).toBe(true)
    expect(isTestPath('src/thing_test.py')).toBe(true)
    expect(isTestPath('tests/unit_tests/conftest.py')).toBe(false)
    expect(isTestPath('hooks/register.test.tsx')).toBe(false)
  })
  test('pytest commands are found inside longer command lines', () => {
    expect(isPytestCommand('uv run pytest tests/unit_tests/ --no-cov')).toBe(true)
    expect(isPytestCommand('cd x && .venv/bin/pytest -q')).toBe(true)
    expect(isPytestCommand('grep -rn pytest_plugins tests/')).toBe(false)
  })
  test('only answers about tests ask for proposed tests', () => {
    expect(mentionsTests('I will add a test for the 404.')).toBe(true)
    expect(mentionsTests('Renamed the route.')).toBe(false)
  })
  test('a reply gives the proposed names, NONE gives an empty list', () => {
    expect(parseProposed('- `test_login_expired`\n2. tests/api/test_x.py\n')).toEqual(['test_login_expired', 'tests/api/test_x.py'])
    expect(parseProposed(NONE)).toEqual([])
    expect(parseProposed('  ')).toBe(null)
  })
  test('result words match the Python panel', () => {
    expect(testCounts({ status: 'failed', passed: 14, failed: 2 })).toBe('14 passed · 2 failed')
    expect(testCounts({ status: 'passed', passed: null, failed: 0 })).toBe('passed')
    expect(testCounts({ status: 'stale', passed: 3, failed: 0 })).toBe('3 passed (edited since)')
    expect(testCounts({ status: 'running', passed: null, failed: null })).toBe('running…')
  })
})

describe('pane controls', () => {
  test('prompts for fix, write and continue', () => {
    expect(fixPrompt('tests/a/test_x.py', ['test_a', 'test_b'])).toBe('Fix the failing tests in tests/a/test_x.py: test_a, test_b.')
    expect(fixPrompt('tests/a/test_x.py', [])).toBe('Fix the failing tests in tests/a/test_x.py.')
    expect(writePrompt('test_login_expired')).toBe('Write the proposed test test_login_expired.')
    expect(continuePrompt('Write the hook')).toBe('Continue with: Write the hook')
  })
  test('a checklist item is marked done or removed by its index', () => {
    const list = '[x] Read the mod\n[>] Write the hook\n[ ] Run the tests'
    expect(itemText('[>] Write the hook')).toBe('Write the hook')
    expect(changeItem(list, 1, 'done')).toBe('[x] Read the mod\n[x] Write the hook\n[ ] Run the tests')
    expect(changeItem(list, 2, 'remove')).toBe('[x] Read the mod\n[>] Write the hook')
    expect(changeItem('[ ] Only one', 0, 'remove')).toBe('')
    expect(itemText('[i] Harness broken')).toBe('Harness broken')
    expect(changeItem('[ ] Commit\n[i] Harness broken', 1, 'done')).toBe('[ ] Commit')
  })
  test('the heads-up prompt carries the answer, the checklist and the tests', () => {
    const prompt = headsupPrompt('Done.', '[ ] Run the tests', ['tests/a/test_x.py: 1 failed'])
    expect(prompt.includes('<latest_answer>\nDone.')).toBe(true)
    expect(prompt.includes('<checklist>\n[ ] Run the tests')).toBe(true)
    expect(prompt.includes('<tests>\ntests/a/test_x.py: 1 failed')).toBe(true)
    expect(headsupPrompt(undefined, undefined, []).includes('<tests>\n(none)')).toBe(true)
  })
  test('the ticket comes from the branch name', () => {
    expect(ticketOf('user/PROJ-123-new-feature')).toBe('PROJ-123')
    expect(ticketOf('PROJ-12')).toBe('PROJ-12')
    expect(ticketOf('main')).toBe('')
  })
  test('the commit draft prompt carries the ticket and the diff', () => {
    const prompt = commitDraftPrompt('user/PROJ-123-x', ' a.py | 2 +-')
    expect(prompt.includes('<ticket>PROJ-123</ticket>')).toBe(true)
    expect(prompt.includes('<diff>\n a.py | 2 +-\n</diff>')).toBe(true)
    expect(commitDraftPrompt('', 'd').includes('<ticket>(none)</ticket>')).toBe(true)
  })
  test('commit-diff output with no change gives no diff', () => {
    expect(parseDiff('{"key": "abc", "text": "a.py | 1 +"}')).toEqual({ key: 'abc', text: 'a.py | 1 +' })
    expect(parseDiff('{"key": "", "text": ""}')).toBe(null)
    expect(parseDiff('not json')).toBe(null)
  })
  test('a commit reply loses its code fences; the commit prompt carries the message', () => {
    expect(commitText('```\nPROJ-1 Fix it\n\n- one\n```\n')).toBe('PROJ-1 Fix it\n\n- one')
    expect(commitWithPrompt('PROJ-1 Fix it')).toBe('Commit the staged and changed files with this message:\n\nPROJ-1 Fix it')
  })
  test('compact puts the merged done items at the first done item and keeps the rest', () => {
    const list = '[x] Read a\n[x] Read b\n[>] Write c\n[x] Ran tests\n[ ] Ship'
    expect(doneItems(list)).toEqual(['[x] Read a', '[x] Read b', '[x] Ran tests'])
    expect(compactChecklist(list, '- [X] Read a and b; ran tests')).toBe('[x] Read a and b; ran tests\n[>] Write c\n[ ] Ship')
  })
  test('compact keeps the list when the reply is empty or not shorter', () => {
    const list = '[x] One\n[x] Two\n[ ] Three'
    expect(compactChecklist(list, 'Sorry, no.')).toBe(null)
    expect(compactChecklist(list, '[x] One\n[x] Two')).toBe(null)
    expect(compactChecklist(list, '[ ] One and two')).toBe(null)
  })
  test('the chat commit prompt carries the session notes and leaves out absent ones', () => {
    const prompt = commitChatPrompt('user/PROJ-123-x', { progress: '[x] Added a button', recaps: ['Button added.'], answer: 'Done.' })
    expect(prompt.includes('<ticket>PROJ-123</ticket>')).toBe(true)
    expect(prompt.includes('<checklist>\n[x] Added a button\n</checklist>')).toBe(true)
    expect(prompt.includes('<recaps>\nButton added.\n</recaps>')).toBe(true)
    expect(prompt.includes('<last_answer>\nDone.\n</last_answer>')).toBe(true)
    expect(prompt.includes('<summary>')).toBe(false)
  })
})
