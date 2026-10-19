import type { Card, Check, CheckState, GraphRow, MergeKind } from '../types'
import { type Kind, stepFor } from './command'

/** Runs a command in the repository; `env` is set over the host's environment. */
export type Run = (argv: string[], env?: Record<string, string>) => Promise<{ exitCode: number; stdout: string; stderr: string }>

// The most commits the card lists; the rest are counted in a `… N more` row.
const MAX_COMMITS = 10
const SEP = '\x1f'
const FORMAT = ['', '%h', '%s', '%ae', '%an', '%ct', '%D', '%m', '%p'].join('%x1f')
const PR_FIELDS = 'number,title,state,isDraft,baseRefName,additions,deletions,mergeable,mergeStateStatus,statusCheckRollup'

// MARK: Graph

/** `25m`, `3h`, `2d`: how long ago, in the card's short form. */
export function shortAge(seconds: number, now: number): string {
  const s = Math.max(0, Math.floor(now / 1000) - seconds)
  if (s < 60) return 'now'
  const units: [number, string][] = [
    [365 * 86400, 'y'],
    [30 * 86400, 'mo'],
    [7 * 86400, 'w'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ]
  const [size, unit] = units.find(([size]) => s >= size) as [number, string]
  return `${Math.floor(s / size)}${unit}`
}

/** Branch names from `%D`, local and `origin/` alike; HEAD and tags left out. */
export function branchRefs(decoration: string): string[] {
  return decoration
    .split(', ')
    .map(ref => ref.replace(/^HEAD -> /, ''))
    .filter(ref => ref !== '' && ref !== 'HEAD' && ref !== 'origin/HEAD' && !ref.startsWith('tag: '))
}

/**
 * Each commit's branch labels: a remote branch folds into its local one when both point at the commit, and drops
 * `origin/` when the local one isn't in the graph. A local branch ahead of or behind its remote keeps both labels apart.
 */
export function labelRefs(refsByRow: string[][]): string[][] {
  const locals = new Set(refsByRow.flat().filter(ref => !ref.startsWith('origin/')))
  return refsByRow.map(refs => {
    const labels = refs.flatMap(ref => {
      if (!ref.startsWith('origin/')) return [ref]
      const name = ref.slice('origin/'.length)
      if (refs.includes(name)) return []
      return [locals.has(name) ? ref : name]
    })
    return [...new Set(labels)]
  })
}

// The prefix holds graph characters alone, so its one `*` or `o` is the commit's mark.
const drawLanes = (lanes: string, isBase = false) =>
  lanes.replace(/\*/g, isBase ? '◇' : '●').replace(/o/g, '○').replace(/\|/g, '│').trimEnd()

/** Who `You` is: git's configured email and name; a commit matching either is the person's own. */
export type Me = { email: string; name: string }

const isMe = (me: Me, email: string, name: string) =>
  (me.email !== '' && email.toLowerCase() === me.email.toLowerCase()) || (me.name !== '' && name === me.name)

/** The rows of `git log --graph` in FORMAT, cut after MAX_COMMITS commits. */
export function parseGraph(stdout: string, me: Me, now: number): { rows: GraphRow[]; more: number } {
  const rows: GraphRow[] = []
  let commits = 0
  let more = 0
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const [lanes = '', sha = '', subject = '', authorEmail = '', author = '', time = '0', decoration = '', mark = '>', parents = ''] =
      line.split(SEP)
    const isCommit = line.includes(SEP)
    if (isCommit && commits === MAX_COMMITS) more++
    if (commits === MAX_COMMITS) continue
    if (!isCommit) {
      rows.push({ kind: 'edge', lanes: drawLanes(lanes) })
      continue
    }
    commits++
    const isMine = isMe(me, authorEmail, author)
    // `%m` is `<` for the base's side of `base...head`, `>` for the branch's and `-` for a boundary.
    const isBase = mark === '<'
    rows.push({
      kind: 'commit',
      lanes: drawLanes(lanes, isBase),
      sha,
      subject,
      author: isMine ? 'You' : (author.split(' ')[0] ?? author),
      isMine,
      age: shortAge(Number(time), now),
      refs: branchRefs(decoration),
      isBoundary: lanes.includes('o'),
      isBase,
      parents: parents.split(' ').filter(p => p !== ''),
      brings: 0,
    })
  }
  // A cut graph ends on the lane edges below its last commit, which lead nowhere.
  while (rows.at(-1)?.kind === 'edge') rows.pop()
  const commitRows = rows.filter(r => r.kind === 'commit')
  labelRefs(commitRows.map(r => r.refs)).forEach((refs, i) => (commitRows[i]!.refs = refs))
  return { rows, more }
}

// MARK: Checks and merge state

type RollupItem = { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }

function checkState(item: RollupItem): CheckState {
  if (item.__typename === 'StatusContext') {
    if (item.state === 'SUCCESS') return 'pass'
    return item.state === 'PENDING' || item.state === 'EXPECTED' ? 'pending' : 'fail'
  }
  if (item.status !== 'COMPLETED') return 'pending'
  if (item.conclusion === 'SUCCESS') return 'pass'
  return item.conclusion === 'SKIPPED' || item.conclusion === 'NEUTRAL' ? 'skip' : 'fail'
}

/** A PR's checks from `statusCheckRollup`, one per name: a re-run's latest result wins. */
export function parseChecks(rollup: RollupItem[] | undefined): Check[] {
  const byName = new Map<string, CheckState>()
  // A status context carries its provider (`ci/circleci: static-checks`), which every chip would repeat.
  for (const item of rollup ?? []) byName.set((item.name ?? item.context ?? '?').replace(/^ci\/[^:]+:\s*/, ''), checkState(item))
  return [...byName].map(([name, state]) => ({ name, state }))
}

export type Pr = {
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  baseRefName: string
  additions: number
  deletions: number
  mergeable: string
  mergeStateStatus: string
  statusCheckRollup?: RollupItem[]
}

/** How the branch stands against its base; conflicts a trial merge found win over GitHub's older answer. */
export function mergeKind(pr: Pr | null, conflicts: string[]): MergeKind {
  if (pr?.state === 'MERGED') return 'merged'
  if (pr?.state === 'CLOSED') return 'closed'
  if (conflicts.length > 0 || pr?.mergeable === 'CONFLICTING' || pr?.mergeStateStatus === 'DIRTY') return 'conflicts'
  if (pr === null) return 'ready'
  if (pr.isDraft) return 'draft'
  switch (pr.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return 'ready'
    case 'UNSTABLE':
      return 'failing'
    case 'BEHIND':
      return 'behind'
    case 'BLOCKED':
      return 'blocked'
    default:
      return 'unknown'
  }
}

/** The files `git merge-tree --name-only` found in conflict; none when it merged cleanly or could not run. */
export function conflictedFiles(result: { exitCode: number; stdout: string }): string[] {
  if (result.exitCode !== 1) return []
  return result.stdout.split('\n').slice(1).filter(line => line.trim() !== '')
}

// MARK: GitHub accounts

type Hosts = { hosts?: Record<string, { login: string; active: boolean; state: string }[]> }

/**
 * Runs gh as the active account, and when that fails, as each other logged-in account until one answers: a work repo
 * reads as the work account without knowing which one it is. The account that answered is kept for the next call.
 */
export function ghRunner(run: Run, remembered: { env?: Record<string, string> }): Run {
  return async (argv, env) => {
    const first = await run(argv, { ...remembered.env, ...env })
    if (first.exitCode === 0 || /no pull requests found/i.test(first.stderr)) return first
    const status = await run(['gh', 'auth', 'status', '--json', 'hosts'])
    const accounts = status.exitCode === 0 ? ((JSON.parse(status.stdout) as Hosts).hosts?.['github.com'] ?? []) : []
    for (const account of accounts) {
      if (account.state !== 'success') continue
      const token = await run(['gh', 'auth', 'token', '--user', account.login])
      if (token.exitCode !== 0) continue
      const tokenEnv = { GH_TOKEN: token.stdout.trim() }
      const retry = await run(argv, { ...tokenEnv, ...env })
      if (retry.exitCode === 0 || /no pull requests found/i.test(retry.stderr)) {
        remembered.env = tokenEnv
        return retry
      }
    }
    return first
  }
}

// MARK: The card

async function defaultBranch(git: Run): Promise<string> {
  const head = await git(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return head.exitCode === 0 ? head.stdout.trim().replace(/^origin\//, '') : 'main'
}

/** For each merge on the branch, how many commits it brings in that the base lacks. */
async function countBrought(git: Run, rows: GraphRow[], baseRef: string): Promise<GraphRow[]> {
  return Promise.all(
    rows.map(async row => {
      if (row.kind !== 'commit' || row.isBase || row.isBoundary || row.parents.length < 2) return row
      const [first, ...merged] = row.parents
      const count = await git(['git', 'rev-list', '--count', ...merged, `^${first}`, `^${baseRef}`])
      return { ...row, brings: count.exitCode === 0 ? Number(count.stdout.trim()) || 0 : 0 }
    }),
  )
}

/**
 * Reads a branch, its PR, graph, conflicts and checks into a card; null outside a git repository. The branch is
 * `branch` when it names a local one, and the checked-out branch otherwise.
 */
export async function gather(git: Run, gh: Run, kind: Kind, now: number, branch: string | null = null): Promise<Card | null> {
  const current = await git(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (current.exitCode !== 0) return null
  const checkedOut = current.stdout.trim()
  const isOther =
    branch !== null &&
    branch !== checkedOut &&
    (await git(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0
  const head = isOther ? (branch as string) : checkedOut
  const headRef = isOther ? `refs/heads/${head}` : 'HEAD'

  const [email, name, view] = await Promise.all([
    git(['git', 'config', 'user.email']),
    git(['git', 'config', 'user.name']),
    gh(['gh', 'pr', 'view', ...(isOther ? [head] : []), '--json', PR_FIELDS]),
  ])
  const pr = view.exitCode === 0 ? (JSON.parse(view.stdout) as Pr) : null
  const base = pr?.baseRefName ?? (await defaultBranch(git))
  const remote = await git(['git', 'rev-parse', '--verify', '--quiet', `origin/${base}`])
  const baseRef = remote.exitCode === 0 ? `origin/${base}` : base
  const isOpen = pr === null || pr.state === 'OPEN'

  // First parents only: a stack's merges from below show as one row each, with the commits they bring counted.
  const [log, trial] = await Promise.all([
    git(['git', 'log', '--graph', '--boundary', '--first-parent', `--format=${FORMAT}`, '-n', String(MAX_COMMITS * 4), `${baseRef}...${headRef}`]),
    isOpen && head !== base ? git(['git', 'merge-tree', '--write-tree', '--name-only', '--no-messages', headRef, baseRef]) : null,
  ])
  const parsed = log.exitCode === 0 ? parseGraph(log.stdout, { email: email.stdout.trim(), name: name.stdout.trim() }, now) : { rows: [], more: 0 }
  const rows = await countBrought(git, parsed.rows, baseRef)
  const more = parsed.more
  const files = trial === null ? [] : conflictedFiles(trial)
  const latest = rows.find(row => row.kind === 'commit')

  return {
    title: pr?.title ?? (latest?.kind === 'commit' ? latest.subject : head),
    number: pr?.number ?? null,
    state: pr === null ? 'none' : pr.state === 'OPEN' ? (pr.isDraft ? 'draft' : 'open') : pr.state === 'MERGED' ? 'merged' : 'closed',
    head,
    base,
    merge: { kind: mergeKind(pr, files), files },
    checks: parseChecks(pr?.statusCheckRollup),
    additions: pr?.additions ?? 0,
    deletions: pr?.deletions ?? 0,
    rows,
    more,
    step: stepFor(kind, pr?.number ?? null),
  }
}
