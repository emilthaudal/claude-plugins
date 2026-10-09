// Shell command timings: a name per kind of command, a running record of how long each took, and when one is slow.

import { median } from './ci'

export type CommandStats = { samples: number[]; total: number; count: number }

export type CommandBook = Record<string, CommandStats>

const MAX_SAMPLES = 20
const MIN_SAMPLES = 3
export const SLOW_FACTOR = 2
export const SLOW_FLOOR_MS = 60_000

// Tools whose second word says what ran (`pnpm test`, `docker build`, `gh pr`).
const TWO_WORDS = new Set([
  'npm', 'pnpm', 'yarn', 'npx', 'bun', 'docker', 'git', 'gh', 'bats', 'go', 'make', 'cargo', 'circleci', 'aws',
  'terraform', 'kubectl', 'hatch', 'uv', 'pip', 'python', 'python3', 'node', 'claude', 'colima',
])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
// Loops and waits: their length is whatever they wait for, not the command's own speed.
const POLLING = /^(sleep|until|while|for|watch|wait)\b|\bsleep\s+\d|\bgh\s+(run|pr)\s+(watch|checks\s+.*--watch)/

/** `cd x && FOO=1 pnpm run test -- --ci` reads as `pnpm test`; a polling loop reads as null. */
export function normalize(command: string): string | null {
  const steps = command.trim().split(/\s*(?:&&|;|\|\|)\s*/)
  const step = steps.find(s => !/^(cd|export|source|set|\.)\b/.test(s)) ?? ''
  if (!step || POLLING.test(step) || POLLING.test(command.trim())) return null
  const words = step
    .split(/\s+/)
    .filter(w => !/^[A-Z_][A-Z0-9_]*=/.test(w))
    .filter((w, i, all) => !(all[0] === 'timeout' && i <= 1))
  // `pnpm run test` and `pnpm test` are the same script; `gh run` and `circleci run` are subcommands of their own.
  const isScriptRunner = PACKAGE_MANAGERS.has(words[0]?.split('/').pop() ?? '')
  const [first, ...rest] = words.filter((w, i) => !(isScriptRunner && i === 1 && w === 'run'))
  if (!first) return null
  const tool = first.split('/').pop()!
  // `git -C <dir> status`: a flag that takes a value takes the word after it too.
  const next = rest.find((w, i) => !w.startsWith('-') && !/^["'$(]/.test(w) && !/^-[Cc]$/.test(rest[i - 1] ?? ''))
  if (!TWO_WORDS.has(tool) || !next) return tool

  return `${tool} ${next.replace(/\/+$/, '')}`
}

export function record(book: CommandBook, name: string, ms: number): CommandBook {
  const old = book[name] ?? { samples: [], total: 0, count: 0 }

  return { ...book, [name]: { samples: [...old.samples, ms].slice(-MAX_SAMPLES), total: old.total + ms, count: old.count + 1 } }
}

/** The usual time, once there are enough runs to say. */
export function expected(stats: CommandStats | undefined): number | null {
  return stats && stats.samples.length >= MIN_SAMPLES ? median(stats.samples) : null
}

export function isSlow(elapsedMs: number, usual: number | null): boolean {
  return usual !== null && elapsedMs > SLOW_FACTOR * usual && elapsedMs > SLOW_FLOOR_MS
}

export type Ranked = { name: string; total: number; median: number; count: number }

export function slowest(book: CommandBook, limit = 10): Ranked[] {
  return Object.entries(book)
    .map(([name, s]) => ({ name, total: s.total, median: median(s.samples) ?? 0, count: s.count }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
}
