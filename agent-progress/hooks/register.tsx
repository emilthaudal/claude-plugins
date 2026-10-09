import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Board, CiWatch, ContextFill, RunningCommand, Run, Status, Strip, Turn } from '../types'
import { barCells, gradient, hex } from './bars'
import { palette, parsePalette, setPalette } from './palette'
import { ghAccounts, isFinished, isPush, median, parseCheckRuns, parseStatuses, pushDir, repoOf, runDuration, summarize } from './ci'
import { CI_CONFIG_PATHS, MAX_DURATIONS, SEED_RUNS, SEED_TTL_MS, finishedMessage, isOver, isSilent, newWatch, pollEvery, watchName } from './ciwatch'
import { expected, isSlow, normalize, record, slowest } from './commands'
import type { CommandBook } from './commands'
import { DEFAULT_LIMITS, fillLabel, fillLevel } from './meter'
import type { Limits } from './meter'
import {
  EMPTY,
  RUN_LINGER_MS,
  agentCalled,
  agentEnded,
  agentLaunched,
  agentStepped,
  agentUsedTool,
  clearFinished,
  elapsed,
  isStripVisible,
  isVisible,
  modelLabel,
  parseNotification,
  parseWorkflowMeta,
  progress,
  taskIdsIn,
  taskNotified,
  workflowLaunched,
  workflowStarted,
} from './board'

// The shape names the board's current form: a board an older version kept (one with an "Agents" run of plain Agent
// spawns, which never finishes now) reads as absent instead of being drawn.
const board = atom({ plugin: 'agent-progress', key: 'board' } as const, EMPTY, { shape: 'workflow-runs' })
const now = atom({ plugin: 'agent-progress', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'agent-progress', key: 'isHidden' } as const, false)
const turn = atom({ plugin: 'agent-progress', key: 'turn' } as const, null as Turn | null)
const ci = atom({ plugin: 'agent-progress', key: 'ci' } as const, [] as CiWatch[])
const command = atom({ plugin: 'agent-progress', key: 'command' } as const, null as RunningCommand | null)
const waitingSince = atom({ plugin: 'agent-progress', key: 'waitingSince' } as const, null as number | null)
const fill = atom({ plugin: 'agent-progress', key: 'fill' } as const, null as ContextFill | null)

const TICK_MS = 1000
const SHIMMER_MS = 100
const TURN_LINGER_MS = 10_000
// A finished CI row stays this long, then leaves.
const CI_LINGER_MS = 60_000
const COMMANDS_KEY = 'commands'
const DURATIONS_KEY = 'ci-durations'
const SEED_KEY = 'ci-seed'
// A command shows its timer once it has run this long.
const COMMAND_SHOWN_MS = 5_000
// Questions put to the person: a notification once one has waited this long.
const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const WAITING_NOTIFY_MS = 30_000
const MAX_STRIPS = 6
const QUIET_TOOLS = new Set(['SubagentHandback'])

// MARK: Options

type Settings = {
  watchCi: boolean
  tellClaude: boolean
  notifications: boolean
  sounds: boolean
  limits: Limits
  paletteFile: string
}

function settingsOf(options: PluginOptions): Settings {
  const flag = (key: string, fallback: boolean) => (typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback)
  const count = (key: string, fallback: number) => (typeof options[key] === 'number' && (options[key] as number) > 0 ? (options[key] as number) : fallback)

  return {
    watchCi: flag('watchCi', true),
    tellClaude: flag('tellClaudeWhenCiFinishes', true),
    notifications: flag('notifications', true),
    sounds: flag('sounds', true),
    limits: { warnTokens: count('contextWarnTokens', DEFAULT_LIMITS.warnTokens), badTokens: count('contextBadTokens', DEFAULT_LIMITS.badTokens) },
    paletteFile: typeof options.paletteFile === 'string' ? options.paletteFile : '',
  }
}

let settings = settingsOf({})
// The person's home folder, for `~` in a pushed folder and the palette file; read once when the session starts.
let home = ''

function colors() {
  const p = palette()

  return {
    ok: hex(p.ok),
    bad: hex(p.bad),
    soft: hex(p.lavender),
    pink: hex(p.pink),
    purple: hex(p.purple),
    blue: hex(p.blue),
    rule: hex(p.rule),
    muted: hex(p.muted),
    deep: hex(p.stops[0]!),
    warn: hex(p.warn),
    bright: '#f5f3ff',
  }
}

// MARK: Clock

// Values the hooks share that never draw: kept in the module, not in $.state.
let stepsInFlight = 0
let isTurnActive = false
let frameNo = 0
let site: { requestId: string; columns: number } | null = null
let bars = new Map<string, { columns: number; fraction: number; status: Status }>()
// One toast per slow run and per question, not one a second.
const toldSlow = new Set<number>()
const toldWaiting = new Set<number>()

// The band's clock runs only while something shows or runs; an idle session has no timer at all.
let ticker: { cancel: () => void } | null = null
let shimmering: { cancel: () => void } | null = null

function wake($: EngineInterface) {
  ticker ??= $.clock.every(TICK_MS, () => void quietly(() => tick($)))
}

function rest() {
  ticker?.cancel()
  ticker = null
}

async function tick($: EngineInterface) {
  const at = await $.clock.now()
  const [b, t, watches, running, since] = await Promise.all([read($, board), read($, turn), read($, ci), read($, command), read($, waitingSince)])
  // One tick past each linger, so the row's last redraw hides it.
  const isTurnShown = t !== null && (t.endedAt === null || at - t.endedAt < TURN_LINGER_MS + TICK_MS)
  const isCiShown = watches.some(w => w.endedAt === null || at - w.endedAt < CI_LINGER_MS + TICK_MS)
  const isRunShown = b.runs.some(run => run.endedAt === null || at - run.endedAt < RUN_LINGER_MS + TICK_MS)
  if (!isTurnShown && !isCiShown && !isRunShown && running === null && since === null) return rest()

  await update($, now, () => at)
  await checkCommand($, running, at)
  await checkWaiting($, since, at)
  pollDue($, watches, at)
  if (watches.some(w => w.endedAt !== null && at - w.endedAt > CI_LINGER_MS)) {
    await update($, ci, ws => ws.filter(w => w.endedAt === null || at - w.endedAt <= CI_LINGER_MS))
  }
}

// The running workflow bars shimmer by blit, ten times a second, while any of them runs and nothing else.
function shimmer($: EngineInterface) {
  shimmering ??= $.clock.every(SHIMMER_MS, () => {
    const running = [...bars].filter(([, bar]) => bar.status === 'running')
    if (running.length === 0 || site === null) {
      shimmering?.cancel()
      shimmering = null
      return
    }
    frameNo += 1
    for (const [key, bar] of running) {
      void $.ui.blit({ requestId: site.requestId, key, columns: bar.columns, rows: 1, cells: barCells(bar.fraction, bar.columns, bar.status, frameNo) }).catch(() => undefined)
    }
  })
}

// MARK: Turn

function activityOf(t: Turn): string {
  if (t.endedAt !== null) return t.status === 'done' ? `done in ${elapsed(t.endedAt - t.startedAt)}` : 'stopped'

  return t.current ?? (stepsInFlight > 0 ? 'thinking...' : 'working...')
}

function describeTool(e: { tool: string } & Record<string, unknown>): string {
  const str = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : '')
  const base = (path: string) => path.split('/').pop() ?? path
  if (e.tool === 'Bash') return `$ ${str('command').split('\n')[0]!.slice(0, 60)}`
  if (str('file_path')) return `${e.tool} ${base(str('file_path'))}`
  if (str('pattern')) return `${e.tool} ${str('pattern').slice(0, 40)}`
  if (str('description')) return `${e.tool} ${str('description').slice(0, 40)}`
  if (e.tool.startsWith('mcp__')) return e.tool.split('__').slice(1).join(' ')

  return e.tool
}

/** The context window's fill as of the last response: read once a step ends, not on a timer. */
async function readFill($: EngineInterface) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined) return
  const next = { tokens: context.tokens, percent: context.percent ?? null }
  await update($, fill, old => (old?.tokens === next.tokens && old.percent === next.percent ? old : next))
}

// MARK: Workflows

/** Applies a board change, writing (and redrawing) only when something changed; toasts each workflow that ended. */
async function apply($: EngineInterface, fn: (b: Board, at: number) => Board) {
  const at = await $.clock.now()
  const before = await read($, board)
  if (fn(before, at) === before) return
  let finished: Run[] = []
  await update($, board, b => {
    const next = fn(b, at)
    finished = next.runs.filter(run => run.endedAt !== null && b.runs.some(old => old.id === run.id && old.endedAt === null))

    return next
  })
  await update($, now, () => at)
  wake($)
  for (const run of finished) {
    const icon = run.status === 'done' ? '✓' : '✗'
    $.ui.toast(`${icon} ${run.title} ${run.status === 'done' ? 'finished' : 'failed'} in ${elapsed(run.endedAt! - run.startedAt)}`)
  }
}

// MARK: Commands

async function startCommand($: EngineInterface, name: string, at: number) {
  const book = ((await $.store.get(COMMANDS_KEY)) ?? {}) as CommandBook
  await update($, command, () => ({ name, startedAt: at, expectedMs: expected(book[name]), isSlow: false }))
  wake($)
}

async function endCommand($: EngineInterface, name: string, startedAt: number, isBackground: boolean) {
  const at = await $.clock.now()
  await update($, command, c => (c?.startedAt === startedAt ? null : c))
  toldSlow.delete(startedAt)
  // A background command's call returns as it starts, so its time says nothing.
  if (isBackground) return
  const book = ((await $.store.get(COMMANDS_KEY)) ?? {}) as CommandBook
  await $.store.set(COMMANDS_KEY, record(book, name, at - startedAt))
}

async function checkCommand($: EngineInterface, c: RunningCommand | null, at: number) {
  if (c === null || c.isSlow || !isSlow(at - c.startedAt, c.expectedMs)) return
  await update($, command, old => (old?.startedAt === c.startedAt ? { ...old, isSlow: true } : old))
  if (toldSlow.has(c.startedAt)) return
  toldSlow.add(c.startedAt)
  $.ui.toast(`⚠ ${c.name} has run ${elapsed(at - c.startedAt)}, usually ~${elapsed(c.expectedMs!)}`, { timeoutMs: 8000 })
}

// MARK: Waiting on the person

/** A macOS notification, for when the person is looking at another window or pane. */
async function notify($: EngineInterface, title: string, text: string) {
  if (!settings.notifications) return
  const quote = (s: string) => `"${s.replace(/["\\]/g, '\\$&')}"`
  await $.process.run(['osascript', '-e', `display notification ${quote(text)} with title ${quote(title)}`]).catch(() => undefined)
}

/** One of macOS's own system sounds; elsewhere `afplay` is missing and nothing plays. */
async function chime($: EngineInterface, sound: 'Glass' | 'Basso' | 'Ping') {
  if (!settings.sounds) return
  await $.process.run(['afplay', `/System/Library/Sounds/${sound}.aiff`]).catch(() => undefined)
}

async function checkWaiting($: EngineInterface, since: number | null, at: number) {
  if (since === null || at - since < WAITING_NOTIFY_MS || toldWaiting.has(since)) return
  toldWaiting.add(since)
  $.ui.toast(`Claude is waiting on you (${elapsed(at - since)})`, { timeoutMs: 8000 })
  await notify($, 'Claude Code', 'Claude is waiting for your answer')
  await chime($, 'Ping')
}

// MARK: CI

// The token that reads an owner's repositories: null when the active gh account (or GH_TOKEN) can, else the first
// other account gh is logged in to that can. Found once per owner, kept for the session.
const access = new Map<string, string | null>()

async function tokenFor($: EngineInterface, dir: string, repo: string): Promise<string | null> {
  const owner = repo.split('/')[0]!
  if (access.has(owner)) return access.get(owner)!
  const canRead = async (env: Record<string, string>) =>
    (await $.process.run(['gh', 'api', `repos/${repo}`, '--silent'], { cwd: dir, env })).exitCode === 0
  let token: string | null = null
  if (!(await canRead({}))) {
    const status = await $.process.run(['gh', 'auth', 'status', '--hostname', 'github.com'])
    for (const account of ghAccounts(`${status.stdout}\n${status.stderr}`)) {
      const { exitCode, stdout } = await $.process.run(['gh', 'auth', 'token', '--user', account])
      if (exitCode === 0 && stdout.trim() && (await canRead({ GH_TOKEN: stdout.trim() }))) {
        token = stdout.trim()
        break
      }
    }
  }
  access.set(owner, token)

  return token
}

async function gh($: EngineInterface, dir: string, repo: string, args: string[]): Promise<string | null> {
  const token = await tokenFor($, dir, repo)
  const { exitCode, stdout } = await $.process.run(['gh', ...args], { cwd: dir, env: token === null ? {} : { GH_TOKEN: token } })

  return exitCode === 0 ? stdout : null
}

async function git($: EngineInterface, dir: string, args: string[]): Promise<string | null> {
  const { exitCode, stdout } = await $.process.run(['git', '-C', dir, ...args])

  return exitCode === 0 ? stdout.trim() : null
}

async function checksOf($: EngineInterface, dir: string, repo: string, sha: string) {
  const statuses = await gh($, dir, repo, ['api', `repos/${repo}/commits/${sha}/status`])
  const runs = await gh($, dir, repo, ['api', `repos/${repo}/commits/${sha}/check-runs`])
  if (statuses === null && runs === null) return null

  return [...(statuses ? parseStatuses(statuses) : []), ...(runs ? parseCheckRuns(runs) : [])]
}

/** What a push from `dir` put on GitHub: its repository, branch, commit and pull request. Null when it has no CI. */
async function watchFor($: EngineInterface, dir: string, at: number): Promise<CiWatch | null> {
  const remote = await git($, dir, ['remote', 'get-url', 'origin'])
  const repo = remote === null ? null : repoOf(remote)
  const branch = await git($, dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const sha = await git($, dir, ['rev-parse', 'HEAD'])
  if (!repo || !branch || !sha || branch === 'HEAD') return null
  // A repository whose pushed commit carries no CircleCI or GitHub Actions config has no CI to wait for.
  const config = await git($, dir, ['ls-tree', '--name-only', sha, ...CI_CONFIG_PATHS])
  if (!config) return null
  const pr = (await gh($, dir, repo, ['pr', 'view', branch, '--repo', repo, '--json', 'number', '-q', '.number']))?.trim() ?? ''

  return newWatch({ repo, branch, sha, dir, pr: /^\d+$/.test(pr) ? Number(pr) : null }, at)
}

/** The watch after one look at GitHub; unchanged when GitHub could not be read. */
async function poll($: EngineInterface, watch: CiWatch, at: number): Promise<CiWatch> {
  const checks = await checksOf($, watch.dir, watch.repo, watch.sha)
  if (checks === null) return isOver(watch, at, false) ? { ...watch, endedAt: at } : watch
  const { lastAt: _, ...summary } = summarize(checks)
  const next = { ...watch, ...summary }

  return isOver(next, at, isFinished(next.state)) ? { ...next, endedAt: at } : next
}

/** The usual time: the runs measured here once there are three, else the repo's last merged pull requests. */
async function expectedFor($: EngineInterface, repo: string, dir: string, at: number): Promise<number | null> {
  const own = (((await $.store.get(DURATIONS_KEY)) ?? {}) as Record<string, number[]>)[repo] ?? []
  if (own.length >= 3) return median(own)
  const seeds = ((await $.store.get(SEED_KEY)) ?? {}) as Record<string, { at: number; ms: number[] }>
  const seed = seeds[repo]
  if (seed && at - seed.at < SEED_TTL_MS) return median([...seed.ms, ...own])

  const list = await gh($, dir, repo, ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(SEED_RUNS), '--json', 'headRefOid', '-q', '.[].headRefOid'])
  const ms: number[] = []
  for (const sha of (list ?? '').split('\n').filter(Boolean)) {
    const date = await gh($, dir, repo, ['api', `repos/${repo}/commits/${sha}`, '-q', '.commit.committer.date'])
    const checks = await checksOf($, dir, repo, sha)
    const run = date && checks ? runDuration(date.trim(), checks) : null
    if (run !== null) ms.push(run)
  }
  await $.store.set(SEED_KEY, { ...seeds, [repo]: { at, ms } })

  return median([...ms, ...own])
}

async function remember($: EngineInterface, repo: string, ms: number) {
  const book = ((await $.store.get(DURATIONS_KEY)) ?? {}) as Record<string, number[]>
  await $.store.set(DURATIONS_KEY, { ...book, [repo]: [...(book[repo] ?? []), ms].slice(-MAX_DURATIONS) })
}

async function watchPush($: EngineInterface, dir: string) {
  const at = await $.clock.now()
  const watch = await watchFor($, dir, at)
  if (watch === null) return
  await update($, ci, ws => [...ws.filter(w => w.id !== watch.id), watch])
  wake($)
  const expectedMs = await expectedFor($, watch.repo, dir, at).catch(() => null)
  await update($, ci, ws => ws.map(w => (w.id === watch.id && w.sha === watch.sha ? { ...w, expectedMs } : w)))
}

// When each watch was last polled, and which are being polled now.
const polledAt = new Map<string, number>()
const polling = new Set<string>()

/** Polls each open watch that is due, by its own backoff, one look at a time. */
function pollDue($: EngineInterface, watches: readonly CiWatch[], at: number) {
  for (const watch of watches) {
    const key = `${watch.id}@${watch.sha}`
    const age = at - watch.startedAt
    if (watch.endedAt !== null || polling.has(key) || at - (polledAt.get(key) ?? watch.startedAt) < pollEvery(age)) continue
    polledAt.set(key, at)
    polling.add(key)
    void quietly(async () => {
      const next = await poll($, watch, at)
      await update($, ci, ws => ws.map(w => (w.id === watch.id && w.sha === watch.sha ? next : w)))
      if (next.endedAt !== null) {
        polledAt.delete(key)
        await finishCi($, next)
      }
    }).finally(() => polling.delete(key))
  }
}

async function finishCi($: EngineInterface, watch: CiWatch) {
  if (isSilent(watch)) return
  const message = finishedMessage(watch)
  if (watch.state === 'passed' || watch.state === 'hold') await remember($, watch.repo, watch.endedAt! - watch.startedAt)
  const word = watch.state === 'failed' ? 'failed' : watch.state === 'passed' || watch.state === 'hold' ? 'passed' : 'unfinished'
  $.ui.toast(`${word === 'failed' ? '✗' : word === 'passed' ? '✓' : '…'} ${message}`, { timeoutMs: 10_000 })
  await notify($, `CI ${word}`, watchName(watch))
  await chime($, watch.state === 'failed' ? 'Basso' : 'Glass')
  // Mid-turn, Claude is already at work (often watching CI itself); a prompt queued behind it would only repeat this.
  if (settings.tellClaude && !isTurnActive) void $.prompt.submit({ text: message })
}

// MARK: Safety

// The band is bookkeeping: none of it may fail, delay or alter the call it watches. Work runs through `quietly`, and
// what comes after a call is answered runs unawaited.
async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {}
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content.map(block => (typeof block?.text === 'string' ? block.text : '')).join('\n')
}

function statusHex(status: Status, offset: number, at: number): string {
  if (status === 'done') return colors().ok
  if (status === 'failed') return colors().bad

  return hex(gradient(offset + at / 12_000))
}

const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, home.replace(/\/$/, ''))

export const register: Register = (on, options) => {
  settings = settingsOf(options)

  // Each step on its own: one that fails must not keep the rest from running.
  on('session.start', async ($, e, next) => {
    await quietly(async () => {
      home = (await $.env.get('HOME')) ?? ''
    })
    await quietly(() => $.command.register({ name: 'progress', description: 'Show or hide the agent progress band' }))
    await quietly(() => $.command.register({ name: 'progress-clear', description: 'Remove finished workflow bars and CI rows' }))
    await quietly(() => $.command.register({ name: 'slowest', description: 'List the shell commands that took the most time' }))
    if (settings.paletteFile) {
      await quietly(async () => {
        const text = await $.fs.read(expandHome(settings.paletteFile))
        if (typeof text === 'string') setPalette(parsePalette(text))
      })
    }
    // State outlives a reload of the module: settle whatever the last load left showing.
    wake($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'progress' }, async $ => {
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)

    return { text: hidden ? 'Agent progress hidden.' : 'Agent progress shown.' }
  })

  on('command.run', { command: 'progress-clear' }, async $ => {
    await update($, board, clearFinished)
    await update($, ci, ws => ws.filter(w => w.endedAt === null))

    return { text: 'Finished bars cleared.' }
  })

  on('command.run', { command: 'slowest' }, async $ => {
    const ranked = slowest(((await $.store.get(COMMANDS_KEY)) ?? {}) as CommandBook)
    if (ranked.length === 0) return { text: 'No commands timed yet.' }
    const width = Math.max(...ranked.map(r => r.name.length))
    const rows = ranked.map(r => `${r.name.padEnd(width)}  ${elapsed(r.total).padStart(7)} total  ~${elapsed(r.median)} each  ×${r.count}`)

    return { text: ['Shell commands by total time (all sessions):', ...rows].join('\n') }
  })

  // Every hook below passes its call through untouched: bookkeeping before `next` runs through `quietly`, bookkeeping
  // after it runs unawaited, and `.catch` hands the call on should the hook itself fail.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (e.agentId) {
      const agentId = e.agentId
      if (!QUIET_TOOLS.has(tool)) await quietly(() => apply($, b => agentUsedTool(b, agentId, tool)))

      return next(e)
    }
    if (!isTurnActive) return next(e)

    const current = describeTool(e as unknown as { tool: string } & Record<string, unknown>)
    await quietly(() => update($, turn, t => (t ? { ...t, tools: t.tools + 1, current } : t)))
    if (!WAITING_TOOLS.has(tool)) return next(e)

    let at: number | null = null
    await quietly(async () => {
      const started = await $.clock.now()
      await update($, waitingSince, () => started)
      at = started
      wake($)
    })
    const ran = await next(e)
    const asked = at
    if (asked !== null) {
      toldWaiting.delete(asked)
      void quietly(() => update($, waitingSince, since => (since === asked ? null : since)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Every shell command, the main loop's and the subagents': timed, and a push starts a CI watch.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const name = normalize(e.command)
    const isBackground = e.run_in_background === true
    const isShown = !e.agentId && !isBackground && name !== null
    let at: number | null = null
    await quietly(async () => {
      at = await $.clock.now()
      if (isShown) await startCommand($, name!, at)
    })
    const ran = await next(e)
    const startedAt = at
    void quietly(async () => {
      if (name !== null && startedAt !== null) await endCommand($, name, startedAt, isBackground)
      if (ran.deny || ran.isError || !settings.watchCi || !isPush(e.command)) return
      const dir = pushDir(e.command, await $.session.cwd(), home)
      if (dir !== null) await watchPush($, dir)
    })

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const toolUseId = e.tool_use_id
    await quietly(() => apply($, b => agentCalled(b, toolUseId)))
    const ran = await next(e)
    const launched = (ran.result ?? {}) as { agentId?: string }
    void quietly(() => apply($, b => agentLaunched(b, toolUseId, launched.agentId ?? null)))

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const meta = parseWorkflowMeta(e.script ?? '')
    const title = meta.name ?? e.name ?? 'workflow'
    await quietly(() => apply($, (b, at) => workflowStarted(b, { id: e.tool_use_id, title, phases: meta.phases }, at)))
    const ran = await next(e)
    const launched = ran.result as { taskId?: string; runId?: string; error?: string } | undefined
    const ids = [launched?.taskId, launched?.runId].filter((id): id is string => !!id)
    const isError = !!ran.deny || !!ran.isError || !!launched?.error
    void quietly(() => apply($, (b, at) => workflowLaunched(b, e.tool_use_id, ids.length ? ids : taskIdsIn(ran), isError, at)))

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    isTurnActive = true
    await quietly(async () => {
      const at = await $.clock.now()
      const fresh: Turn = { startedAt: at, endedAt: null, status: 'running', steps: 0, tools: 0, current: null }
      await update($, turn, () => fresh)
      await update($, now, () => at)
      wake($)
    })
    // The fill as the last response left it; each step's end reads it again.
    void quietly(() => readFill($))

    return next(e)
  }).catch(($, e, next) => next(e))

  // The stream is handed on whole by `yield*`: a hook that pulled a chunk and failed before yielding it would drop it,
  // cutting the start off a tool call's input. Bookkeeping happens before the first chunk and after the last.
  on('turn.step', async function* ($, e, next) {
    const isMain = !e.agentId
    await quietly(async () => {
      if (e.agentId) {
        const step = { agentId: e.agentId, model: e.model, effort: e.effort === undefined ? null : String(e.effort) }
        await apply($, (b, at) => agentStepped(b, step, at))
      } else if (isTurnActive) {
        await update($, turn, t => (t ? { ...t, steps: t.steps + 1, current: null } : t))
      }
    })

    if (isMain) stepsInFlight += 1
    try {
      return yield* next(e)
    } finally {
      if (isMain) {
        stepsInFlight = Math.max(0, stepsInFlight - 1)
        void quietly(() => readFill($))
      }
    }
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await quietly(async () => {
      if (e.agentId) {
        const agentId = e.agentId
        await apply($, (b, at) => agentEnded(b, agentId, e.reason === 'answer', at))
      } else if (isTurnActive) {
        const at = await $.clock.now()
        isTurnActive = false
        const status: Status = e.reason === 'answer' ? 'done' : 'failed'
        await update($, turn, t => (t ? { ...t, endedAt: at, status, current: null } : t))
        await update($, now, () => at)
      }
    })
    if (!e.agentId) isTurnActive = false

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    if (e.door === 'delivery' && e.origin.kind === 'task-notification') {
      const note = parseNotification(textOf(e.message.content))
      if (note) await quietly(() => apply($, (b, at) => taskNotified(b, note.taskId, note.status, at)))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, board)
    const at = Math.max(await read($, now), ...b.runs.map(run => run.endedAt ?? run.startedAt))
    const runs = b.runs.filter(run => isVisible(run, at))
    const t = await read($, turn)
    const isTurnShown = t !== null && (t.endedAt === null || at - t.endedAt < TURN_LINGER_MS)
    const watches = (await read($, ci)).filter(w => w.endedAt === null || at - w.endedAt < CI_LINGER_MS)
    const since = await read($, waitingSince)
    const running = await read($, command)
    const context = await read($, fill)
    const isEmpty = runs.length === 0 && !isTurnShown && watches.length === 0 && since === null
    if (e.props.hasSurvey || isEmpty || (await read($, isHidden))) {
      site = null
      bars = new Map()
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : null
    const C = colors()
    const columns = e.props.bodyColumns
    const barWidth = Math.max(10, Math.min(40, columns - 60))
    site = Raster ? { requestId: e.requestId, columns } : null
    const nextBars = new Map<string, { columns: number; fraction: number; status: Status }>()
    const fillHex = { ok: C.soft, warn: C.warn, bad: C.bad }

    // Elapsed, what Claude is doing (a question to the person first, then a running command with its usual time), and
    // the context window's fill.
    const turnRow = (t: Turn) => {
      const isRunning = t.endedAt === null
      const isOk = t.status !== 'failed'
      const shownCommand = running !== null && at - running.startedAt >= COMMAND_SHOWN_MS ? running : null
      const activity =
        since !== null ? (
          <Text color={at - since > 120_000 ? C.bad : C.warn} bold wrap="truncate">waiting on you {elapsed(at - since)}</Text>
        ) : shownCommand !== null ? (
          <Text color={shownCommand.isSlow ? C.bad : C.pink} wrap="truncate">
            $ {shownCommand.name} {elapsed(at - shownCommand.startedAt)}
            <Text color={shownCommand.isSlow ? C.bad : C.muted}>
              {shownCommand.expectedMs === null ? '' : shownCommand.isSlow ? `  usually ~${elapsed(shownCommand.expectedMs)}` : ` of ~${elapsed(shownCommand.expectedMs)}`}
            </Text>
          </Text>
        ) : (
          <Text color={C.pink} wrap="truncate">{activityOf(t)}</Text>
        )

      return (
        <Box gap={1}>
          <Text color={since !== null ? C.warn : isRunning ? C.soft : isOk ? C.ok : C.bad} bold>{since !== null ? '?' : isRunning ? '◆' : isOk ? '✓' : '✗'}</Text>
          <Text color={C.soft}>{elapsed((t.endedAt ?? at) - t.startedAt)}</Text>
          <Box flexGrow={1} flexShrink={1}>{activity}</Box>
          <Text color={C.purple}>{t.tools} tools</Text>
          {context !== null && <Text color={fillHex[fillLevel(context, settings.limits)]}>{fillLabel(context, settings.limits)}</Text>}
        </Box>
      )
    }

    // A question can come while no turn row shows (a dialog right after a turn ends): it still gets a row.
    const waitingRow = (s: number) => (
      <Box gap={1}>
        <Text color={C.warn} bold>?</Text>
        <Text color={at - s > 120_000 ? C.bad : C.warn} bold>waiting on you {elapsed(at - s)}</Text>
      </Box>
    )

    const ciRow = (w: CiWatch) => {
      const isDone = w.endedAt !== null
      const accent = w.state === 'failed' ? C.bad : w.state === 'passed' || w.state === 'hold' ? C.ok : isDone ? C.muted : C.blue
      const icon = w.state === 'failed' ? '✗' : w.state === 'passed' || w.state === 'hold' ? '✓' : isDone ? '·' : '●'
      const took = elapsed((w.endedAt ?? at) - w.startedAt)
      const status =
        w.state === 'failed'
          ? `failed: ${w.failed.join(', ')}`
          : w.state === 'passed'
            ? `passed in ${took}`
            : w.state === 'hold'
              ? `passed in ${took} · awaiting approval`
              : isDone
                ? 'stopped watching'
                : w.state === 'waiting'
                  ? 'waiting for checks'
                  : `running ${w.done}/${w.total}`
      const isLate = !isDone && w.expectedMs !== null && at - w.startedAt > 2 * w.expectedMs

      return (
        <Box gap={1}>
          <Text color={accent} bold>{icon}</Text>
          <Text color={C.bright} bold>CI</Text>
          <Box flexShrink={1}>
            <Text color={C.soft} wrap="truncate">{watchName(w)}{w.pr !== null && <Text color={C.muted}> {w.branch}</Text>}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={accent} wrap="truncate">{status}</Text>
          </Box>
          {!isDone && (
            <Text color={isLate ? C.bad : C.blue}>
              {took}
              {w.expectedMs === null ? '' : ` of ~${elapsed(w.expectedMs)}`}
            </Text>
          )}
        </Box>
      )
    }

    // A workflow's agent: what it runs on, what it is doing, and for how long.
    const stripRow = (strip: Strip, i: number, isLast: boolean) => {
      const model = [modelLabel(strip.model), strip.effort].filter(Boolean).join(' · ')
      const activity = strip.status === 'running' ? (strip.tool ?? 'thinking') : strip.status
      const accent = statusHex(strip.status, i * 0.13, at)

      return (
        <Box gap={1} paddingLeft={3}>
          <Text color={C.deep}>{isLast ? '╰─' : '├─'}</Text>
          <Text color={accent}>{strip.status === 'running' ? '◆' : strip.status === 'done' ? '✓' : '✗'}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={strip.status === 'running' ? C.bright : C.soft} wrap="truncate">{strip.label}</Text>
          </Box>
          <Box flexShrink={0} gap={2}>
            {model && <Text color={C.blue}>{model}</Text>}
            <Text color={strip.status === 'running' ? C.pink : C.muted}>
              {activity}
              {strip.tools > 0 ? ` ×${strip.tools}` : ''}
            </Text>
            <Text color={C.purple}>{elapsed((strip.endedAt ?? at) - strip.startedAt)}</Text>
          </Box>
        </Box>
      )
    }

    const runRow = (run: Run, index: number) => {
      const fraction = progress(run)
      const done = run.strips.filter(s => s.status !== 'running').length
      const strips = run.strips.filter(s => isStripVisible(s, run, at))
      const shown = strips.slice(-MAX_STRIPS)
      const hiddenCount = strips.length - shown.length
      const accent = statusHex(run.status, index * 0.21, at)
      const key = `bar-${index}`
      if (Raster) nextBars.set(key, { columns: barWidth, fraction, status: run.status })
      const filled = Math.round(fraction * barWidth)

      return (
        <Box flexDirection="column" marginTop={isTurnShown || index > 0 ? 1 : 0}>
          <Box gap={1} paddingLeft={1}>
            <Text color={accent} bold>{run.status === 'running' ? '◆' : run.status === 'done' ? '✓' : '✗'}</Text>
            <Box flexShrink={1}>
              <Text color={C.bright} bold wrap="truncate">{run.title}</Text>
            </Box>
            {Raster ? (
              <Raster key={key} columns={barWidth} rows={1} cells={barCells(fraction, barWidth, run.status, frameNo)} />
            ) : (
              <Text>
                <Text color={accent}>{'━'.repeat(filled)}</Text>
                <Text color={C.rule}>{'─'.repeat(barWidth - filled)}</Text>
              </Text>
            )}
            <Text color={C.pink} bold>{String(Math.round(fraction * 100)).padStart(3)}%</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={C.purple} wrap="truncate">
                {done}/{run.strips.length} agents
                {run.phases.length > 0 ? ` · ${run.phases.join(' ▸ ')}` : ''}
              </Text>
            </Box>
            <Text color={C.blue}>{elapsed((run.endedAt ?? at) - run.startedAt)}</Text>
          </Box>
          {hiddenCount > 0 && <Text color={C.muted}>{'   '}├─ +{hiddenCount} more</Text>}
          {shown.map((strip, i) => stripRow(strip, i, i === shown.length - 1))}
        </Box>
      )
    }

    const tree = (
      <Box flexDirection="column">
        {isTurnShown && t ? turnRow(t) : since !== null && waitingRow(since)}
        {watches.map(ciRow)}
        {runs.map(runRow)}
      </Box>
    )
    bars = nextBars
    if ([...bars.values()].some(bar => bar.status === 'running')) shimmer($)

    return tree
  })
}
