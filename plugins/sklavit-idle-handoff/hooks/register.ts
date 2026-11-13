import type { EngineInterface, PluginOptions, Register, SessionContextUsage, Timer } from 'claude-code'

const DEFAULT_IDLE_MINUTES = 50
// Below this many conversation tokens a cold re-read is cheap: no handoff needed.
const DEFAULT_MIN_TOKENS = 40_000
const HANDOFF_COMMAND = 'mattpocock-skills:handoff'

const LAST_TURN = { plugin: 'sklavit-idle-handoff', key: 'lastTurn' } as const

// What the handoff document must keep. The model fills it in during the handoff turn.
export const BRIEF = [
  'Preserve the following, concretely, and prefer them over narrative:',
  '',
  '- goal: the one-sentence objective of the session as it now stands.',
  '- next: the immediate next action, verb-anchored (edit <path>, run <command>,',
  '  inspect <file> for <issue>, ask user <question>, wait for agent <id>),',
  '  concrete enough to execute without asking the user to restate it.',
  '- files: the minimum set of paths needed to execute next, spec or plan first',
  '  and code after in relevance order. Drop scratch and throwaway files.',
  '- decisions: what was decided and why, and constraints the user stated as',
  '  hard requirements or anti-patterns.',
  '- blockers: review findings not yet addressed, failing tests, questions',
  '  awaiting the user.',
  '- state: uncommitted changes, test status with the shortest command that',
  '  reruns them, work left mid-implementation, and any subagent still running.',
  '',
  'Quote paths, identifiers, commands, decisions and constraints verbatim.',
  'Drop exploratory dead ends that were not acted on, unless one underpins a',
  'blocker or a decision that still stands.',
].join('\n')

type State = {
  timer?: Timer
  // Bumped on every disarm, so an arm still awaiting its reads can tell it was overtaken.
  generation: number
  // Set while the handoff turn runs: its turn.complete must not re-arm, or it repeats every idle stretch.
  isHandingOff: boolean
}

function nonNegative(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

const idleDelayMs = (options: PluginOptions) => (nonNegative(options.idleMinutes) || DEFAULT_IDLE_MINUTES) * 60_000
const minTokens = (options: PluginOptions) => nonNegative(options.minTokens) ?? DEFAULT_MIN_TOKENS
const approx = (n: number) => (n < 1000 ? `${n}` : `${Math.round(n / 1000)}k`)

/** The conversation as /context's Messages row counts it; the whole context when there is no breakdown. */
function conversationTokens(context: SessionContextUsage) {
  const row = context.breakdown?.categories.find((c) => c.kind === 'used' && c.name === 'Messages')
  return row?.tokens ?? context.tokens
}

function disarm(state: State) {
  state.generation++
  state.timer?.cancel()
  state.timer = undefined
}

function forget($: EngineInterface) {
  return $.state.set(LAST_TURN, null).catch(() => {})
}

async function handOffIfWorthIt($: EngineInterface, state: State, floor: number) {
  try {
    const { context } = await $.session.usage({ breakdown: 'full' })
    const conversation = conversationTokens(context) ?? 0
    if (conversation < floor) {
      $.ui.log(`no handoff: the conversation is ${approx(conversation)} tokens, under the ${approx(floor)} floor`)
      return
    }
    state.isHandingOff = true
    await $.command.run({ command: HANDOFF_COMMAND, args: BRIEF })
  } catch {
    // An unknown command or a busy session: no handoff turn will follow, so let the next turn re-arm.
    state.isHandingOff = false
  }
}

function schedule($: EngineInterface, state: State, ms: number, floor: number) {
  state.timer = $.clock.after(ms, () => {
    state.timer = undefined
    void handOffIfWorthIt($, state, floor)
  })
}

async function arm($: EngineInterface, state: State, options: PluginOptions) {
  disarm(state)
  const armed = state.generation
  const idleSince = await $.clock.now()
  const sessionId = await $.session.id()
  if (armed !== state.generation) return
  schedule($, state, idleDelayMs(options), minTokens(options))
  await $.state.set(LAST_TURN, { sessionId, at: idleSince })
  // A turn.start that disarmed meanwhile may have cleared it before this write landed.
  if (armed !== state.generation) await forget($)
}

/** After a reload, which cancels the timer: re-arms for what is left of the delay since the last turn. */
async function rearm($: EngineInterface, state: State, options: PluginOptions) {
  disarm(state)
  const armed = state.generation
  const { value: last } = await $.state.get(LAST_TURN)
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  if (armed !== state.generation || !last || last.sessionId !== sessionId) return
  const left = last.at + idleDelayMs(options) - now
  if (left > 0) schedule($, state, left, minTokens(options))
}

/**
 * Arms a timer when a main-loop turn completes and cancels it when the next turn starts or the session
 * ends. When it fires and the conversation is big enough, runs the handoff skill with BRIEF as its
 * argument, once per idle stretch.
 */
export const register: Register = (on, options) => {
  const state: State = { generation: 0, isHandingOff: false }

  on('turn.start', async ($, e, next) => {
    disarm(state)
    await forget($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    if (state.isHandingOff) {
      state.isHandingOff = false
      return result
    }
    // never let arming the timer break the turn
    await arm($, state, options).catch(() => {})
    return result
  })

  on('session.end', async ($, e, next) => {
    disarm(state)
    state.isHandingOff = false
    await forget($)
    return next(e)
  })

  // Also fires on a reload of the module (/reload-plugins, an options change), which cancels the timer.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await rearm($, state, options).catch(() => {})
    return result
  })
}
