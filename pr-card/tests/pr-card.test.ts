import { expect, mock, test, type TestBody } from 'claude-code/testing'
import { directoryOf, prCommand, pushedBranch } from '../hooks/command'
import { checkChips, diffBar, mergeLabel } from '../hooks/draw'
import {
  branchRefs,
  conflictedFiles,
  ghRunner,
  labelRefs,
  mergeKind,
  parseChecks,
  parseGraph,
  type Pr,
  type Run,
  shortAge,
} from '../hooks/git'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const NOW = Date.UTC(2026, 9, 18, 12)
const ago = (minutes: number) => String(Math.floor(NOW / 1000) - minutes * 60)
const line = (lanes: string, sha: string, subject: string, email: string, name: string, minutes: number, refs = '', mark = '>', parents = '') =>
  [lanes, sha, subject, email, name, ago(minutes), refs, mark, parents].join('\x1f')

// The branch and main each moved on from `Bump next to 16.3`.
const GRAPH = [
  line('* ', 'd29f50', 'Add session refresh tests', 'me@x.com', 'Ada Lovelace', 0, 'HEAD -> feat/session-refresh, origin/feat/session-refresh', '>', 'c70a92'),
  line('| * ', 'a3f9c1', 'Rotate session keys', 'lena@x.com', 'Lena Berg', 18, 'origin/main', '<', '9c2d4a'),
  line('* | ', 'c70a92', 'Refresh sessions near expiry', 'me@x.com', 'Ada Lovelace', 25, '', '>', '9c2d4a'),
  '|/  ',
  line('o ', '9c2d4a', 'Bump next to 16.3', 'sam@x.com', 'Sam Holt', 180, 'tag: v1.2.0', '-', '71e0b3'),
].join('\n')

// A stack mid-update, as the first-parent graph draws it: the branch merged its base's new tip, which isn't pushed.
const STACK = [
  line('*   ', 'a454ba8', 'Merge AS-480 into AS-479', 'me@x.com', 'Ada', 0, 'HEAD -> AS-479', '>', '668aba5 b597666'),
  line('* ', '668aba5', 'AS-479: order pull', 'me@x.com', 'Ada', 60, 'origin/AS-479', '>', 'a36b6be'),
  line('| o ', 'b597666', 'Merge AS-475 into AS-480', 'me@x.com', 'Ada', 1, 'AS-480', '-', 'a36b6be 6ddfca8'),
  '|/  ',
  line('o ', 'a36b6be', 'AS-480: webhook auth', 'me@x.com', 'Ada', 7200, 'origin/AS-480', '-', '8cb71fc'),
].join('\n')

const PR: Pr = {
  number: 128,
  title: 'Refresh sessions in the auth middleware',
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  additions: 482,
  deletions: 37,
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'Lint', status: 'IN_PROGRESS' },
    { __typename: 'StatusContext', context: 'ci/circleci: Preview', state: 'SUCCESS' },
  ],
}

// MARK: Commands

test('knows the commands that touch a PR', () => {
  expect(prCommand('git push -u origin HEAD')).toBe('push')
  expect(prCommand('cd ~/w/api && git -C sub push')).toBe('push')
  expect(prCommand(`gh pr create --title "x" --body-file - <<'EOF'\nbody\nEOF`)).toBe('create')
  expect(prCommand('gh pr merge 12 --squash')).toBe('merge')
  expect(prCommand('gh pr status')).toBe('view')
  for (const command of ['git status', 'git commit -m "push it"', 'gh pr list', 'gh issue create', 'echo gh pr']) {
    expect(prCommand(command)).toBe(null)
  }
})

test('finds the branch a push names', () => {
  expect(pushedBranch('git push -q origin AS-476 2>&1 | tail -2')).toBe('AS-476')
  expect(pushedBranch('git push -u --force-with-lease origin "feat/x"')).toBe('feat/x')
  expect(pushedBranch('git push -o ci.skip origin +refs/heads/a:b')).toBe('a')
  expect(pushedBranch('git push origin a && for b in c d; do git push origin "$b"; done')).toBe(null)
  for (const command of ['git push', 'git push -u origin HEAD', 'git push origin --delete old', 'git push --all origin', 'git status']) {
    expect(pushedBranch(command)).toBe(null)
  }
})

test('finds the directory a command ran in', () => {
  expect(directoryOf('git push', '/repo', '/home/ada')).toBe('/repo')
  expect(directoryOf('cd ~/work/api && git push', '/repo', '/home/ada')).toBe('/home/ada/work/api')
  expect(directoryOf('cd sub && cd "deep dir" && gh pr view', '/repo', '/home/ada')).toBe('/repo/sub/deep dir')
  expect(directoryOf('git -C /elsewhere push', '/repo', '/home/ada')).toBe('/elsewhere')
})

// MARK: Parsing

test('reads the graph: lanes, authors, ages and branch names', () => {
  const { rows, more } = parseGraph(GRAPH, { email: 'ME@x.com', name: '' }, NOW)
  expect(more).toBe(0)
  expect(rows.map(r => r.lanes)).toEqual(['●', '│ ◇', '● │', '│/', '○'])
  expect(rows[0]).toMatchObject({ kind: 'commit', author: 'You', isMine: true, age: 'now', refs: ['feat/session-refresh'], isBase: false })
  expect(rows[1]).toMatchObject({ author: 'Lena', isMine: false, age: '18m', refs: ['main'], isBase: true })
  expect(rows[4]).toMatchObject({ isBoundary: true, isBase: false, age: '3h', refs: [], parents: ['71e0b3'] })
})

test('keeps a local branch and its remote apart when they point at different commits', () => {
  const { rows } = parseGraph(STACK, { email: 'me@x.com', name: '' }, NOW)
  const refs = rows.flatMap(r => (r.kind === 'commit' ? [r.refs] : []))
  expect(refs).toEqual([['AS-479'], ['origin/AS-479'], ['AS-480'], ['origin/AS-480']])
  expect(rows[0]).toMatchObject({ parents: ['668aba5', 'b597666'], brings: 0 })
})

test('cuts a long graph after ten commits and counts the rest', () => {
  const long = Array.from({ length: 14 }, (_, i) => line('* ', `s${i}`, `c${i}`, 'me@x.com', 'Ada', i)).join('\n|\n')
  const { rows, more } = parseGraph(long, { email: 'other@x.com', name: 'Ada' }, NOW)
  expect(rows[0]).toMatchObject({ author: 'You', isMine: true })
  expect(rows.filter(r => r.kind === 'commit')).toHaveLength(10)
  expect(rows.at(-1)?.kind).toBe('commit')
  expect(more).toBe(4)
})

test('shortens ages and branch decorations', () => {
  expect(shortAge(Number(ago(60 * 24 * 9)), NOW)).toBe('1w')
  expect(branchRefs('HEAD -> a, origin/a, origin/HEAD, tag: v1, origin/b')).toEqual(['a', 'origin/a', 'origin/b'])
  expect(labelRefs([['a', 'origin/a', 'origin/b'], ['origin/c']])).toEqual([['a', 'b'], ['c']])
})

test('reads checks, a re-run winning', () => {
  const checks = parseChecks([
    ...(PR.statusCheckRollup ?? []),
    { __typename: 'CheckRun', name: 'Tests', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'Deploy', status: 'COMPLETED', conclusion: 'SKIPPED' },
  ])
  expect(checks).toEqual([
    { name: 'Tests', state: 'fail' },
    { name: 'Lint', state: 'pending' },
    { name: 'Preview', state: 'pass' },
    { name: 'Deploy', state: 'skip' },
  ])
  expect(checkChips(checks, 3)).toEqual({ shown: [checks[0], checks[1]], folded: 2 })
})

test('says how the branch stands against its base', () => {
  const open = { ...PR, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }
  expect(mergeKind(open, [])).toBe('ready')
  expect(mergeKind(open, ['a.ts'])).toBe('conflicts')
  expect(mergeKind(PR, [])).toBe('conflicts')
  expect(mergeKind({ ...open, mergeStateStatus: 'BEHIND' }, [])).toBe('behind')
  expect(mergeKind({ ...open, state: 'MERGED' }, ['a.ts'])).toBe('merged')
  expect(mergeKind(null, [])).toBe('ready')
  expect(conflictedFiles({ exitCode: 1, stdout: 'abc123\nsrc/a.ts\nsrc/b.ts\n' })).toEqual(['src/a.ts', 'src/b.ts'])
  expect(conflictedFiles({ exitCode: 0, stdout: 'abc123\n' })).toEqual([])
})

test('splits a diff bar like GitHub', () => {
  expect(diffBar(482, 37)).toEqual({ added: 3, removed: 1, empty: 1 })
  expect(diffBar(10, 0)).toEqual({ added: 4, removed: 0, empty: 1 })
  expect(diffBar(0, 0)).toEqual({ added: 0, removed: 0, empty: 5 })
})

// MARK: GitHub accounts

test('tries the other gh accounts when the active one cannot see the repository', async () => {
  const calls: string[] = []
  const run: Run = async (argv, env) => {
    calls.push(`${env?.GH_TOKEN ?? '-'} ${argv.join(' ')}`)
    if (argv[2] === 'status') {
      const hosts = { 'github.com': [{ login: 'ada', active: true, state: 'success' }, { login: 'ada-work', active: false, state: 'success' }] }
      return { exitCode: 0, stdout: JSON.stringify({ hosts }), stderr: '' }
    }
    if (argv[2] === 'token') return { exitCode: 0, stdout: `tok-${argv[4]}\n`, stderr: '' }
    const isWork = env?.GH_TOKEN === 'tok-ada-work'
    return isWork ? { exitCode: 0, stdout: '{}', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'Could not resolve to a Repository' }
  }
  const remembered: { env?: Record<string, string> } = {}
  const gh = ghRunner(run, remembered)
  expect((await gh(['gh', 'pr', 'view'])).exitCode).toBe(0)
  expect(remembered.env).toEqual({ GH_TOKEN: 'tok-ada-work' })
  calls.length = 0
  await gh(['gh', 'pr', 'view'])
  expect(calls).toEqual(['tok-ada-work gh pr view'])
})

test('a branch with no PR is no reason to try other accounts', async () => {
  let runs = 0
  const gh = ghRunner(async () => (runs++, { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "x"' }), {})
  await gh(['gh', 'pr', 'view'])
  expect(runs).toBe(1)
})

// MARK: Hooks

// Stands for the repository at /repo: answers git and gh from fixtures, and keeps each Bash call's id.
function repo($: Engine, on: On, pr: Pr | null = PR, graph = GRAPH, calls: string[] = []): (command: string) => Promise<string> {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/ada' })
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('process.run', async (_, e) => {
    const argv = e.argv.join(' ')
    calls.push(argv)
    const answer = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr } }) as never
    if (argv === 'git rev-parse --abbrev-ref HEAD') return answer(0, 'feat/session-refresh\n')
    if (argv === 'git config user.email') return answer(0, 'me@x.com\n')
    if (argv === 'git config user.name') return answer(0, 'Ada Lovelace\n')
    if (argv.startsWith('gh pr view')) return pr ? answer(0, JSON.stringify(pr)) : answer(1, '', 'no pull requests found')
    if (argv.startsWith('git rev-parse --verify')) return answer(0, 'abc\n')
    if (argv.startsWith('git symbolic-ref')) return answer(0, 'origin/main\n')
    if (argv.startsWith('git log')) return answer(0, graph)
    if (argv.startsWith('git rev-list --count')) return answer(0, '4\n')
    if (argv.startsWith('git merge-tree')) return answer(1, 'tree\nsrc/auth.ts\nsrc/middleware.ts\n')
    return answer(1, '', `unexpected: ${argv}`)
  })
  // The engine's own drawing, for the rows the mod leaves alone.
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['engine'] }) as never)
  let id = ''
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    id = e.tool_use_id
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  return async command => {
    await $.tool.call({ tool: 'Bash', command })
    return id
  }
}

type Shown = { find: (q: { type: string }) => Promise<{ text: string } | undefined> }
const shown = async (ui: Shown) => (await ui.find({ type: 'Box' }))?.text ?? (await ui.find({ type: 'Text' }))?.text ?? ''

const result = ($: Engine, id: string) =>
  $.ui.mount({
    plugin: 'pr-card',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool: 'Bash', output: { stdout: '', stderr: '', interrupted: false }, isErrored: false },
  })

const band = ($: Engine) =>
  $.ui.mount({
    plugin: 'pr-card',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never,
  })

test('draws a card under a push', async ($, on) => {
  const id = await repo($, on)('git push -u origin HEAD')
  const text = await shown(await result($, id))
  for (const part of ['Refresh sessions in the auth middleware', '#128', '● Open', 'Merge into main', '2 conflicts', 'Rotate session keys', 'c70a92', 'Lena · 18m']) {
    expect(text).toContain(part)
  }
  expect(text).toContain('Conflicts in src/auth.ts, src/middleware.ts')
  expect(text).toContain('Pushed to origin')
  expect(text).toContain('+482')
})

test('a push that names another branch draws that branch, not the checkout', async ($, on) => {
  const calls: string[] = []
  await repo($, on, PR, GRAPH, calls)('git commit -qam fix && git push -q origin AS-476 2>&1 | tail -2; git checkout AS-479')
  expect(calls).toContain(`gh pr view AS-476 --json ${calls.find(c => c.startsWith('gh pr view'))?.split('--json ')[1]}`)
  expect(calls.find(c => c.startsWith('git log'))).toEndWith('origin/main...refs/heads/AS-476')
  expect(calls.find(c => c.startsWith('git merge-tree'))).toContain('refs/heads/AS-476 origin/main')
})

test('counts the commits a stack merge brings in', async ($, on) => {
  const calls: string[] = []
  const id = await repo($, on, PR, STACK, calls)('git push')
  expect(calls).toContain('git rev-list --count b597666 ^668aba5 ^origin/main')
  const text = await shown(await result($, id))
  expect(text).toContain('Merge AS-480 into AS-479 +4 commits')
  expect(text).toContain('origin/AS-480')
})

test('shows the PR above the prompt once a command has read it', async ($, on) => {
  await repo($, on)('gh pr view')
  const text = await shown(await band($))
  expect(text).toContain('#128')
  expect(text).toContain('2 conflicts')
  expect(text).toContain('1 running')
  // Whatever else the band shows stays, below the pill.
  expect(text).toContain('engine')
})

test('leaves other commands to the engine', async ($, on) => {
  const id = await repo($, on)('git status')
  expect(await shown(await result($, id))).toBe('engine')
})

test('a branch with no PR gets a card but no pill', async ($, on) => {
  const id = await repo($, on, null)('git push')
  const text = await shown(await result($, id))
  expect(text).toContain('Add session refresh tests')
  expect(text).toContain('no PR yet')
  expect(await shown(await band($))).toBe('engine')
})

test('a card says how many conflicts once their files are known', () => {
  const card = { merge: { kind: 'conflicts', files: ['a'] } } as never
  expect(mergeLabel(card)).toBe('1 conflict')
})
