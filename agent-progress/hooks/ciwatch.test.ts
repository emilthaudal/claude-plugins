import { expect, test } from 'claude-code/testing'

import { finishedMessage, newWatch, pollEvery } from './ciwatch'

test('young CI is polled often, older CI less', async () => {
  expect(pollEvery(0)).toBe(15_000)
  expect(pollEvery(5 * 60_000)).toBe(30_000)
  expect(pollEvery(30 * 60_000)).toBe(60_000)
})

test('Claude is told the outcome, naming a branch once', async () => {
  const base = newWatch({ repo: 'someone/plugins', branch: 'main', sha: 'abc', dir: '/w', pr: null }, 0)
  expect(finishedMessage({ ...base, state: 'passed', endedAt: 90_000 })).toBe('CI passed for someone/plugins main after 1:30.')
  expect(finishedMessage({ ...base, pr: 7, state: 'failed', failed: ['lint'], endedAt: 60_000 })).toBe(
    'CI failed for someone/plugins#7 (main) after 1:00: lint.',
  )
})
