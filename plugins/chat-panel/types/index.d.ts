export type PanelData = {
  headline: { tag: string; line: string; shownAt: number; isLive: boolean } | null
  summary: { text: string; mtimeMs: number } | null
  commit?: { text: string; mtimeMs: number } | null
  notes: { text: string; mtimeMs: number } | null
  progress: { text: string; mtimeMs: number } | null
  recaps: { at: string; text: string; source: 'away' | 'recap' | 'auto' }[]
  branch: string
  tests?: {
    files: { path: string; status: TestStatus; passed: number | null; failed: number | null; failing: string[]; moreFailing: number; atMs: number }[]
    proposed: string[]
  }
  time: { headline: string; summary: string; progress: string; commit?: string; recaps: string[] }
}

export type TestStatus = 'passed' | 'failed' | 'running' | 'stale' | 'not-run' | 'timeout' | 'error'

/** The main loop's tool labels and visible text of the running turn. */
export type TurnBuffer = { tools: string[]; texts: string[]; hasNewText: boolean }

/** A finished turn the poll has still to recap and add to the progress checklist. */
export type PendingTurn = { answer: string; tools: string[]; texts: string[] }

declare module 'claude-code' {
  interface PluginState {
    'chat-panel': { data: PanelData | null; turn: TurnBuffer; pending: PendingTurn | null; last: PendingTurn | null; selected: number; help: boolean; commitKey: string }
  }
}
