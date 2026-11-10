import type { ContextCategory, ContextCategoryKind, On, SessionContextBreakdown, TurnCompleteInput } from 'claude-code'
import { type Engine, expect, mock, test, tier } from 'claude-code/testing'
import { BRIEF } from '../hooks/register'

tier('user')

const MIN = 60_000
const T0 = Date.parse('2026-11-10T18:00:00')

type Stored = { sessionId: string; at: number } | null

const row = (name: string, tokens: number, kind: ContextCategoryKind = 'used'): ContextCategory =>
  ({ name, tokens, kind, color: 'inactive', isDeferred: false })

function breakdown(messages: number): SessionContextBreakdown {
  const total = messages + 20_000
  return {
    categories: [row('System prompt', 20_000), row('Messages', messages), row('Free space', 1_000_000 - total, 'free')],
    totalTokens: total, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autocompactSource: 'model-default', percentage: 1,
    gridRows: [], model: 'test', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
  }
}

/** Answers everything the module reads beneath it, and records each command it runs. */
function setup(on: On, { messages = 200_000, stored = null as Stored, runThrows = false } = {}) {
  const clock = mock.clock(on, { now: T0 })
  const seen = { runs: [] as { command: string; args: string }[], logs: [] as string[], stored }
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: messages + 20_000, window: 1_000_000, breakdown: breakdown(messages) }, rateLimits: [] } }))
  on('command.run', (_$, e) => {
    if (runThrows) throw new Error('unknown command')
    seen.runs.push({ command: e.command, args: e.args })
    return {}
  })
  on('ui.log', (_$, e) => (seen.logs.push(e.text), { value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('state.get', () => ({ value: { value: seen.stored, version: 0 } }))
  on('state.set', (_$, e) => {
    seen.stored = e.value as Stored
    return { value: { isSet: true as const, version: 1 } }
  })
  return { clock, seen }
}

const turnDone = ($: Engine, extra: Partial<TurnCompleteInput> = {}) =>
  $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra } as TurnCompleteInput)
const turnStart = ($: Engine) => $.turn.start({ text: 'back', turnId: 't2' })
const reload = ($: Engine) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

async function idle(clock: { advance(ms: number): Promise<void>; settle(): Promise<void> }, ms: number) {
  await clock.advance(ms)
  await clock.settle()
}

test('runs the handoff with the brief 50 minutes after the last turn', async ($, on) => {
  const { clock, seen } = setup(on)
  await turnDone($)
  await idle(clock, 50 * MIN - 1)
  expect(seen.runs).toEqual([])
  await idle(clock, 2)
  expect(seen.runs).toEqual([{ command: 'mattpocock-skills:handoff', args: BRIEF }])
})

test('the idleMinutes option overrides the delay', { options: { idleMinutes: 5 } }, async ($, on) => {
  const { clock, seen } = setup(on)
  await turnDone($)
  await idle(clock, 5 * MIN + 1)
  expect(seen.runs.length).toBe(1)
})

test('a new turn cancels the timer', async ($, on) => {
  const { clock, seen } = setup(on)
  await turnDone($)
  await idle(clock, 30 * MIN)
  await turnStart($)
  await idle(clock, 2 * 60 * MIN)
  expect(seen.runs).toEqual([])
})

test('the session end cancels the timer', async ($, on) => {
  const { clock, seen } = setup(on)
  await turnDone($)
  await $.session.end({ sessionId: 's1', reason: 'clear' } as never)
  await idle(clock, 2 * 60 * MIN)
  expect(seen.runs).toEqual([])
})

test('a subagent turn does not arm the timer', async ($, on) => {
  const { clock, seen } = setup(on)
  await turnDone($, { agentId: 'a1' })
  await idle(clock, 2 * 60 * MIN)
  expect(seen.runs).toEqual([])
})

test('a conversation under the floor gets no handoff', async ($, on) => {
  const { clock, seen } = setup(on, { messages: 12_000 })
  await turnDone($)
  await idle(clock, 50 * MIN + 1)
  expect(seen.runs).toEqual([])
  expect(seen.logs).toEqual(['no handoff: the conversation is 12k tokens, under the 40k floor'])
})

test('the minTokens option moves the floor', { options: { minTokens: 10_000 } }, async ($, on) => {
  const { clock, seen } = setup(on, { messages: 12_000 })
  await turnDone($)
  await idle(clock, 50 * MIN + 1)
  expect(seen.runs.length).toBe(1)
})

test('the handoff turn does not re-arm: one handoff per idle stretch', async ($, on) => {
  const { clock, seen } = setup(on)
  await turnDone($)
  await idle(clock, 50 * MIN + 1)
  await turnStart($)
  await turnDone($)
  await idle(clock, 3 * 60 * MIN)
  expect(seen.runs.length).toBe(1)
})

test('the user turn after a handoff arms again', async ($, on) => {
  const { clock, seen } = setup(on)
  await turnDone($)
  await idle(clock, 50 * MIN + 1)
  await turnStart($)
  await turnDone($)
  await turnStart($)
  await turnDone($)
  await idle(clock, 50 * MIN + 1)
  expect(seen.runs.length).toBe(2)
})

test('a failed command run lets the next turn re-arm', async ($, on) => {
  const { clock, seen } = setup(on, { runThrows: true })
  await turnDone($)
  await idle(clock, 50 * MIN + 1)
  await turnStart($)
  await turnDone($)
  expect(seen.stored).toEqual({ sessionId: 's1', at: T0 + 50 * MIN + 1 })
})

test('a reload re-arms for the time left since the last turn', async ($, on) => {
  const { clock, seen } = setup(on, { stored: { sessionId: 's1', at: T0 - 20 * MIN } })
  await reload($)
  await idle(clock, 30 * MIN - 1)
  expect(seen.runs).toEqual([])
  await idle(clock, 2)
  expect(seen.runs.length).toBe(1)
})

test('a reload past the deadline does nothing', async ($, on) => {
  const { clock, seen } = setup(on, { stored: { sessionId: 's1', at: T0 - 2 * 60 * MIN } })
  await reload($)
  await idle(clock, 3 * 60 * MIN)
  expect(seen.runs).toEqual([])
})
