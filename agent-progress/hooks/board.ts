// Workflow runs and the agents inside them. Plain Agent spawns are not drawn (Claude Code lists them under the prompt),
// but their ids are kept so their steps are never mistaken for a workflow's.
//
// Every function returns the board it was given when nothing changed, so callers can skip a write.

import type { Board, Run, Strip } from '../types'

export const EMPTY: Board = { runs: [], pending: [], agents: [] }

const MAX_RUNS = 12
const MAX_AGENTS = 50

export function modelLabel(model: string | null): string {
  if (!model) return ''
  const match = model.match(/(opus|sonnet|haiku|fable)-(\d+)-(\d+)/)

  return match ? `${match[1]} ${match[2]}.${match[3]}` : model
}

export function parseWorkflowMeta(script: string): { name: string | null; phases: string[] } {
  const name = script.match(/meta\s*=\s*\{[\s\S]*?name\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? null
  const block = script.match(/phases\s*:\s*\[([\s\S]*?)\]\s*,?\s*\}/)?.[1] ?? ''
  const phases = [...block.matchAll(/title\s*:\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]!)

  return { name, phases }
}

/** The task and run ids a Workflow call's result mentions, which its task notification will name. */
export function taskIdsIn(value: unknown): string[] {
  const text = JSON.stringify(value) ?? ''
  const ids = new Set<string>()
  for (const m of text.matchAll(/\b(wf_[a-z0-9-]{6,})/g)) ids.add(m[1]!)
  for (const m of text.matchAll(/"(?:taskId|task_id|runId|run_id)"\s*:\s*"([^"]+)"/g)) ids.add(m[1]!)
  for (const m of text.matchAll(/task[ _-]?id[:\s]+([A-Za-z0-9_-]{6,})/gi)) ids.add(m[1]!)

  return [...ids]
}

export function parseNotification(text: string): { taskId: string; status: string } | null {
  const taskId = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim()
  const status = text.match(/<status>([^<]+)<\/status>/)?.[1]?.trim()

  return taskId && status ? { taskId, status } : null
}

function hasStrip(board: Board, agentId: string): boolean {
  return board.runs.some(run => run.strips.some(s => s.id === agentId))
}

function mapStrip(board: Board, agentId: string, fn: (strip: Strip) => Strip): Board {
  if (!hasStrip(board, agentId)) return board
  let isChanged = false
  const runs = board.runs.map(run => {
    if (!run.strips.some(s => s.id === agentId)) return run
    const strips = run.strips.map(s => {
      if (s.id !== agentId) return s
      const next = fn(s)
      if (next !== s) isChanged = true

      return next
    })

    return { ...run, strips }
  })

  return isChanged ? { ...board, runs } : board
}

function openWorkflow(board: Board): Run | undefined {
  return [...board.runs].reverse().find(run => run.endedAt === null)
}

function rememberAgent(board: Board, agentId: string): Board {
  return board.agents.includes(agentId) ? board : { ...board, agents: [...board.agents, agentId].slice(-MAX_AGENTS) }
}

/** An Agent call is about to spawn a subagent: its first step belongs to it, not to a workflow. */
export function agentCalled(board: Board, toolUseId: string): Board {
  return { ...board, pending: [...board.pending, toolUseId] }
}

/** The Agent call answered; a background spawn names its agent here. */
export function agentLaunched(board: Board, toolUseId: string, agentId: string | null): Board {
  const rest = board.pending.includes(toolUseId) ? { ...board, pending: board.pending.filter(id => id !== toolUseId) } : board

  return agentId === null || hasStrip(rest, agentId) ? rest : rememberAgent(rest, agentId)
}

export function workflowStarted(board: Board, e: { id: string; title: string; phases: string[] }, now: number): Board {
  const run: Run = { id: e.id, title: e.title, phases: e.phases, taskIds: [], status: 'running', startedAt: now, endedAt: null, strips: [] }

  return { ...board, runs: [...board.runs, run].slice(-MAX_RUNS) }
}

export function workflowLaunched(board: Board, id: string, taskIds: string[], isError: boolean, now: number): Board {
  return {
    ...board,
    runs: board.runs.map(run => (run.id !== id ? run : isError ? { ...run, status: 'failed', endedAt: now } : { ...run, taskIds })),
  }
}

/** A subagent's step: a workflow's agent is added or updated; a plain Agent spawn is remembered and left out. */
export function agentStepped(board: Board, e: { agentId: string; model: string; effort: string | null }, now: number): Board {
  if (hasStrip(board, e.agentId)) {
    return mapStrip(board, e.agentId, s =>
      s.model === e.model && (e.effort === null || s.effort === e.effort) ? s : { ...s, model: e.model, effort: e.effort ?? s.effort },
    )
  }
  if (board.agents.includes(e.agentId)) return board
  if (board.pending.length > 0) return rememberAgent({ ...board, pending: board.pending.slice(1) }, e.agentId)
  const workflow = openWorkflow(board)
  if (!workflow) return board
  const strip: Strip = {
    id: e.agentId,
    label: `agent ${workflow.strips.length + 1}`,
    model: e.model,
    effort: e.effort,
    tool: null,
    tools: 0,
    status: 'running',
    startedAt: now,
    endedAt: null,
  }

  return { ...board, runs: board.runs.map(run => (run.id === workflow.id ? { ...run, strips: [...run.strips, strip] } : run)) }
}

export function agentUsedTool(board: Board, agentId: string, tool: string): Board {
  return mapStrip(board, agentId, s => (s.status === 'running' ? { ...s, tool, tools: s.tools + 1 } : s))
}

export function agentEnded(board: Board, agentId: string, isOk: boolean, now: number): Board {
  if (board.agents.includes(agentId)) return { ...board, agents: board.agents.filter(id => id !== agentId) }

  return mapStrip(board, agentId, s => (s.status === 'running' ? { ...s, status: isOk ? 'done' : 'failed', tool: null, endedAt: now } : s))
}

/** A background task finished: the workflow it belongs to ends with it, and so does a background agent of that id. */
export function taskNotified(board: Board, taskId: string, status: string, now: number): Board {
  const isOk = status === 'completed'
  const isWorkflow = board.runs.some(run => run.endedAt === null && run.taskIds.includes(taskId))
  const ended: Board = !isWorkflow
    ? board
    : {
        ...board,
        runs: board.runs.map(run => {
          if (run.endedAt !== null || !run.taskIds.includes(taskId)) return run
          const strips = run.strips.map(s => (s.status === 'running' ? { ...s, status: 'done' as const, tool: null, endedAt: now } : s))

          return { ...run, strips, status: isOk ? ('done' as const) : ('failed' as const), endedAt: now }
        }),
      }

  return agentEnded(ended, taskId, isOk, now)
}

export function clearFinished(board: Board): Board {
  return board.runs.every(run => run.endedAt === null) ? board : { ...board, runs: board.runs.filter(run => run.endedAt === null) }
}

export const RUN_LINGER_MS = 20_000

export function isVisible(run: Run, now: number): boolean {
  return run.endedAt === null || now - run.endedAt < RUN_LINGER_MS
}

export function isStripVisible(strip: Strip, run: Run, now: number): boolean {
  return strip.endedAt === null || run.endedAt !== null || now - strip.endedAt < 6_000
}

export function progress(run: Run): number {
  if (run.endedAt !== null && run.status === 'done') return 1
  if (run.strips.length === 0) return 0

  return run.strips.filter(s => s.status !== 'running').length / run.strips.length
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
