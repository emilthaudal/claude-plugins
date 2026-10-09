import { expect, test } from 'claude-code/testing'

import { ghAccounts, median, parseCheckRuns, parseStatuses, pushDir, repoOf, runDuration, summarize } from './ci'

// A real pull request's head commit as GitHub reported it, trimmed to the fields read and with its job names made up.
const STATUSES = JSON.stringify({
  state: 'failure',
  statuses: [
    { context: 'ci/circleci: install', state: 'success', description: 'Your tests passed on CircleCI!', updated_at: '2026-10-05T07:02:08Z' },
    { context: 'ci/circleci: lint', state: 'success', description: 'Your tests passed on CircleCI!', updated_at: '2026-10-05T07:02:11Z' },
    { context: 'ci/circleci: run-unit-tests-test', state: 'success', description: 'Your tests passed on CircleCI!', updated_at: '2026-10-05T07:02:51Z' },
    { context: 'ci/circleci: plan-test', state: 'success', description: 'Your tests passed on CircleCI!', updated_at: '2026-10-05T07:02:58Z' },
    { context: 'ci/circleci: deploy/hold-test', state: 'failure', description: 'Your job was cancelled on CircleCI!', updated_at: '2026-10-05T07:03:01Z' },
  ],
})
const CHECK_RUNS = JSON.stringify({
  check_runs: [{ name: 'Security scan', status: 'completed', conclusion: 'success', completed_at: '2026-10-05T07:02:15Z' }],
})

test('reads CircleCI statuses, a cancelled approval hold not counting as a failure', async () => {
  const checks = parseStatuses(STATUSES)
  expect(checks.map(c => c.name)).toContain('run-unit-tests-test')
  expect(checks.find(c => c.name === 'deploy/hold-test')?.bucket).toBe('cancel')
  expect(summarize([...checks, ...parseCheckRuns(CHECK_RUNS)])).toMatchObject({ state: 'passed', failed: [], done: 6, total: 6 })
})

test('is running while anything is pending, failed once the rest are done', async () => {
  const running = parseStatuses(JSON.stringify({ statuses: [
    { context: 'ci/circleci: lint', state: 'failure', description: 'Your tests failed on CircleCI!' },
    { context: 'ci/circleci: test', state: 'pending' },
  ] }))
  expect(summarize(running)).toMatchObject({ state: 'running', failed: ['lint'], done: 1, total: 2 })
  expect(summarize(running.map(c => ({ ...c, bucket: c.bucket === 'pending' ? 'pass' : c.bucket })))).toMatchObject({ state: 'failed' })
  expect(summarize([]).state).toBe('waiting')
})

test('a pending approval is a hold, and CI that waits only on it is finished', async () => {
  const held = parseStatuses(JSON.stringify({ statuses: [
    { context: 'ci/circleci: test', state: 'success' },
    { context: 'ci/circleci: deploy/hold-test', state: 'pending', description: 'On hold' },
  ] }))
  expect(summarize(held).state).toBe('hold')
  expect(summarize(parseCheckRuns(JSON.stringify({ check_runs: [{ name: 'x', status: 'in_progress' }] }))).state).toBe('running')
})

test('finds the folder a push ran in', async () => {
  const home = '/home/someone'
  expect(pushDir('git push -u origin HEAD', '/repo', home)).toBe('/repo')
  expect(pushDir('cd /work/service && git push', '/x', home)).toBe('/work/service')
  expect(pushDir('git -C ~/code/plugins push', '/x', home)).toBe('/home/someone/code/plugins')
  expect(pushDir('cd sub && gh pr create --fill', '/repo', home)).toBe('/repo/sub')
  expect(pushDir('git push --tags', '/repo', home)).toBe(null)
  expect(pushDir('git push --dry-run', '/repo', home)).toBe(null)
  expect(pushDir('git status', '/repo', home)).toBe(null)
  expect(pushDir('echo "git pushed"', '/repo', home)).toBe(null)
})

test('names a repository from its remote', async () => {
  expect(repoOf('git@github.com:acme/service.git\n')).toBe('acme/service')
  expect(repoOf('https://github.com/someone/plugins.git')).toBe('someone/plugins')
  expect(repoOf('https://gitlab.com/x/y.git')).toBe(null)
})

test('times a past run from its commit to its last check', async () => {
  const checks = [...parseStatuses(STATUSES), ...parseCheckRuns(CHECK_RUNS)]
  expect(runDuration('2026-10-05T07:01:43Z', checks)).toBe(78_000)
  expect(runDuration('2026-09-01T00:00:00Z', checks)).toBe(null)
  expect(median([5, 1, 3])).toBe(3)
  expect(median([1, 2, 3, 4])).toBe(2.5)
  expect(median([])).toBe(null)
})

test('lists the accounts gh is logged in to', async () => {
  const status = `github.com
  ✓ Logged in to github.com account work-me (keyring)
  - Active account: true
  ✓ Logged in to github.com account home-me (keyring)
  - Active account: false`
  expect(ghAccounts(status)).toEqual(['work-me', 'home-me'])
  expect(ghAccounts('You are not logged into any GitHub hosts.')).toEqual([])
})
