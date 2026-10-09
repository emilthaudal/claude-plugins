export type Status = 'running' | 'done' | 'failed'

/** One agent inside a workflow run. */
export type Strip = {
  id: string
  label: string
  model: string | null
  effort: string | null
  tool: string | null
  tools: number
  status: Status
  startedAt: number
  endedAt: number | null
}

/** A Workflow call, from its launch to its task notification. */
export type Run = {
  id: string
  title: string
  phases: string[]
  taskIds: string[]
  status: Status
  startedAt: number
  endedAt: number | null
  strips: Strip[]
}

/**
 * Workflow runs, plus what keeps plain Agent spawns off them: the Agent calls not yet stepped (`pending`, their
 * tool use ids) and the subagents known to be plain spawns (`agents`).
 */
export type Board = { runs: Run[]; pending: string[]; agents: string[] }

export type Turn = {
  startedAt: number
  endedAt: number | null
  status: Status
  steps: number
  tools: number
  current: string | null
}

export type CiState = 'waiting' | 'running' | 'hold' | 'passed' | 'failed'

/** CI for one pushed commit, polled until it finishes. */
export type CiWatch = {
  id: string
  repo: string
  branch: string
  sha: string
  dir: string
  pr: number | null
  state: CiState
  failed: string[]
  done: number
  total: number
  expectedMs: number | null
  startedAt: number
  endedAt: number | null
}

/** The main loop's Bash call while it runs, with how long that command usually takes. */
export type RunningCommand = { name: string; startedAt: number; expectedMs: number | null; isSlow: boolean }

export type ContextFill = { tokens: number; percent: number | null }

declare module 'claude-code' {
  interface PluginState {
    'agent-progress': {
      board: Shaped<Board>
      now: number
      isHidden: boolean
      turn: Turn | null
      ci: CiWatch[]
      command: RunningCommand | null
      waitingSince: number | null
      fill: ContextFill | null
    }
  }
}
