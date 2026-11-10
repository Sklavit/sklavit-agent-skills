// sklavit-idle-handoff's contract: the one value it keeps in `$.state`.

/** When the session's last main-loop turn ended; lets a reloaded module re-arm its timer. */
export type IdleHandoffLastTurn = { sessionId: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    // null while a turn runs and after the session ends
    'sklavit-idle-handoff': { lastTurn: IdleHandoffLastTurn | null }
  }
}
