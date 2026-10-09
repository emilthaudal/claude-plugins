// What a CI watch is called and says when it ends; register.tsx does the watching, since only it may hold `$`.

import type { CiWatch } from '../types'
import { elapsed } from './board'

export const WATCH_LIMIT_MS = 60 * 60_000
// Where a repository keeps the CI config the watcher knows: CircleCI's and GitHub Actions'.
export const CI_CONFIG_PATHS = ['.circleci', '.github/workflows']
// A commit no CI reports on within this is a repository without CI.
export const NO_CI_MS = 10 * 60_000
export const SEED_TTL_MS = 24 * 60 * 60_000

/** How often a watch is polled: often while CI is young, less as it runs on. */
export function pollEvery(ageMs: number): number {
  return ageMs < 2 * 60_000 ? 15_000 : ageMs < 10 * 60_000 ? 30_000 : 60_000
}
export const SEED_RUNS = 5
export const MAX_DURATIONS = 20

export function newWatch(fields: Pick<CiWatch, 'repo' | 'branch' | 'sha' | 'dir' | 'pr'>, at: number): CiWatch {
  return {
    ...fields,
    id: `${fields.repo}@${fields.branch}`,
    state: 'waiting',
    failed: [],
    done: 0,
    total: 0,
    expectedMs: null,
    startedAt: at,
    endedAt: null,
  }
}

/** Whether the watch is over at `at`: CI finished, ran past the limit, or never reported at all. */
export function isOver(watch: CiWatch, at: number, isFinished: boolean): boolean {
  return isFinished || at - watch.startedAt > WATCH_LIMIT_MS || (watch.total === 0 && at - watch.startedAt > NO_CI_MS)
}

/** A watch that ended because CI never reported: a repository without CI, so nothing to tell. */
export function isSilent(watch: CiWatch): boolean {
  return watch.state === 'waiting' && watch.total === 0
}

export function watchName(watch: CiWatch): string {
  return watch.pr === null ? `${watch.repo} ${watch.branch}` : `${watch.repo}#${watch.pr}`
}

/** What Claude is told when CI it pushed finishes. */
export function finishedMessage(watch: CiWatch): string {
  const name = watch.pr === null ? watchName(watch) : `${watchName(watch)} (${watch.branch})`
  const took = watch.endedAt === null ? '' : ` after ${elapsed(watch.endedAt - watch.startedAt)}`
  if (watch.state === 'passed') return `CI passed for ${name}${took}.`
  if (watch.state === 'hold') return `CI passed for ${name}${took} and is waiting for an approval.`
  if (watch.state === 'failed') return `CI failed for ${name}${took}: ${watch.failed.join(', ')}.`

  return `Stopped watching CI for ${name}: still running after an hour.`
}
