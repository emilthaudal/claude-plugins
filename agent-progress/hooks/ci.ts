// CI for a pushed commit, read from GitHub's commit statuses (CircleCI reports there) and check runs (Actions and other
// GitHub apps).

import type { CiState } from '../types'

export type { CiState }

export type Bucket = 'pass' | 'fail' | 'pending' | 'hold' | 'cancel'

export type Check = { name: string; bucket: Bucket; at: number | null }

export type CiSummary = { state: CiState; failed: string[]; done: number; total: number; lastAt: number | null }

type Status = { context?: string; state?: string; description?: string | null; updated_at?: string }
type CheckRun = { name?: string; status?: string; conclusion?: string | null; completed_at?: string | null }

const HOLD = /\bhold\b|approv/i
const CANCELLED = /cancel/i

function time(iso: string | null | undefined): number | null {
  const at = iso ? Date.parse(iso) : NaN

  return Number.isFinite(at) && at > 0 ? at : null
}

/** `ci/circleci: run-unit-tests-test` reads as `run-unit-tests-test`. */
export function shortName(name: string): string {
  return name.replace(/^ci\/circleci:\s*/, '')
}

/** The `statuses` of GET /repos/{repo}/commits/{sha}/status. A cancelled approval hold is not a failure. */
export function parseStatuses(json: string): Check[] {
  const raw = JSON.parse(json) as { statuses?: Status[] }

  return (raw.statuses ?? []).map(s => {
    const name = shortName(s.context ?? 'status')
    const description = s.description ?? ''
    let bucket: Bucket = s.state === 'success' ? 'pass' : s.state === 'pending' ? 'pending' : 'fail'
    if (bucket === 'pending' && HOLD.test(name)) bucket = 'hold'
    if (bucket === 'fail' && CANCELLED.test(description)) bucket = 'cancel'

    return { name, bucket, at: time(s.updated_at) }
  })
}

/** The `check_runs` of GET /repos/{repo}/commits/{sha}/check-runs. */
export function parseCheckRuns(json: string): Check[] {
  const raw = JSON.parse(json) as { check_runs?: CheckRun[] }

  return (raw.check_runs ?? []).map(run => {
    const conclusion = run.conclusion ?? ''
    const bucket: Bucket =
      run.status !== 'completed'
        ? 'pending'
        : ['success', 'neutral', 'skipped'].includes(conclusion)
          ? 'pass'
          : conclusion === 'cancelled'
            ? 'cancel'
            : conclusion === 'action_required'
              ? 'hold'
              : 'fail'

    return { name: run.name ?? 'check', bucket, at: time(run.completed_at) }
  })
}

/** Still running while anything is pending; a failure only counts once nothing is left to run. */
export function summarize(checks: readonly Check[]): CiSummary {
  const failed = checks.filter(c => c.bucket === 'fail').map(c => c.name)
  const pending = checks.filter(c => c.bucket === 'pending').length
  const isHeld = checks.some(c => c.bucket === 'hold')
  const done = checks.filter(c => c.bucket !== 'pending' && c.bucket !== 'hold').length
  const times = checks.map(c => c.at).filter((at): at is number => at !== null)
  const state: CiState =
    checks.length === 0 ? 'waiting' : pending > 0 ? 'running' : failed.length > 0 ? 'failed' : isHeld ? 'hold' : 'passed'

  return { state, failed, done, total: checks.length, lastAt: times.length ? Math.max(...times) : null }
}

export function isFinished(state: CiState): boolean {
  return state === 'passed' || state === 'failed' || state === 'hold'
}

// MARK: Pushes

const PUSH = /(^|[;&|]\s*|\s)(git(\s+-C\s+\S+)?\s+push\b|gh\s+pr\s+create\b)/
const NOT_A_BRANCH_PUSH = /--dry-run|--tags\b|--delete\b|\s-d\s/

/** Whether a shell command pushes a branch (`git push`, `gh pr create`), so its CI is worth watching. */
export function isPush(command: string): boolean {
  return PUSH.test(command) && !NOT_A_BRANCH_PUSH.test(command)
}

/**
 * The folder a pushing command ran in: its `cd <dir>` or `git -C <dir>`, else the session's, with `~` as `home`.
 * Null when it pushes no branch.
 */
export function pushDir(command: string, cwd: string, home: string): string | null {
  if (!isPush(command)) return null
  const dir = command.match(/git\s+-C\s+("[^"]+"|'[^']+'|\S+)/)?.[1] ?? command.match(/(?:^|[;&]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&]+)/)?.[1]
  if (!dir) return cwd
  const bare = dir.replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, home.replace(/\/$/, ''))

  return bare.startsWith('/') ? bare : `${cwd.replace(/\/$/, '')}/${bare}`
}

/** `git@github.com:acme/service.git` or an https remote reads as `acme/service`. */
export function repoOf(remote: string): string | null {
  return remote.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? null
}

// MARK: Durations

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** How long a past run took: from its commit to the last check it reported. */
export function runDuration(committedAt: string, checks: readonly Check[]): number | null {
  const start = time(committedAt)
  const { lastAt, state } = summarize(checks)
  if (start === null || lastAt === null || state !== 'passed') return null
  const ms = lastAt - start

  // A commit pushed long after it was made says nothing about CI's own time.
  return ms > 0 && ms < 90 * 60_000 ? ms : null
}

// MARK: Accounts

/** The accounts `gh auth status` lists for github.com, in its order (the active one first among them or not). */
export function ghAccounts(statusOutput: string): string[] {
  return [...new Set([...statusOutput.matchAll(/Logged in to github\.com account (\S+)/g)].map(m => m[1]!))]
}
