import { expect, test } from 'claude-code/testing'

import { expected, isSlow, normalize, record, slowest } from './commands'
import { fillLabel, fillLevel } from './meter'

test('names a command by its tool and what it ran', async () => {
  expect(normalize('bats tests/')).toBe('bats tests')
  expect(normalize('cd /w/x && FOO=1 pnpm run test -- --ci')).toBe('pnpm test')
  expect(normalize('docker build -t x .')).toBe('docker build')
  expect(normalize('gh pr view 12 --json state')).toBe('gh pr')
  expect(normalize('/opt/homebrew/bin/circleci run get --failure-report')).toBe('circleci run')
  expect(normalize('timeout 300 npx tsc -p .')).toBe('npx tsc')
  expect(normalize('ls -la')).toBe('ls')
  expect(normalize('git -C /w status')).toBe('git status')
})

test('leaves polling loops and waits unnamed', async () => {
  expect(normalize('sleep 30')).toBe(null)
  expect(normalize('until gh pr checks 3; do sleep 20; done')).toBe(null)
  expect(normalize('for i in 1 2 3; do gh pr checks; done')).toBe(null)
  expect(normalize('gh run watch 123')).toBe(null)
  expect(normalize('cd x && sleep 5 && gh pr checks')).toBe(null)
})

test('knows the usual time after three runs and calls a run past twice that slow', async () => {
  let book = record({}, 'bats tests', 110_000)
  book = record(book, 'bats tests', 120_000)
  expect(expected(book['bats tests'])).toBe(null)
  book = record(book, 'bats tests', 130_000)
  expect(expected(book['bats tests'])).toBe(120_000)
  expect(isSlow(200_000, 120_000)).toBe(false)
  expect(isSlow(250_000, 120_000)).toBe(true)
  // A quick command is never slow, whatever its ratio.
  expect(isSlow(50_000, 10_000)).toBe(false)
  expect(isSlow(250_000, null)).toBe(false)
})

test('keeps the last twenty runs and ranks commands by total time', async () => {
  let book = {}
  for (let i = 0; i < 25; i++) book = record(book, 'git push', 1000)
  book = record(book, 'docker build', 100_000)
  const ranked = slowest(book)
  expect(ranked[0]).toMatchObject({ name: 'docker build', total: 100_000, count: 1 })
  expect(ranked[1]).toMatchObject({ name: 'git push', total: 25_000, median: 1000, count: 25 })
  expect((book as Record<string, { samples: number[] }>)['git push']!.samples.length).toBe(20)
})

test('colours the context fill by tokens or percent', async () => {
  expect(fillLevel({ tokens: 120_000, percent: 12 })).toBe('ok')
  expect(fillLevel({ tokens: 210_000, percent: 21 })).toBe('warn')
  expect(fillLevel({ tokens: 140_000, percent: 70 })).toBe('warn')
  expect(fillLevel({ tokens: 310_000, percent: 31 })).toBe('bad')
  expect(fillLevel({ tokens: 170_000, percent: 85 })).toBe('bad')
  expect(fillLabel({ tokens: 124_000, percent: 62 })).toBe('ctx 62% 124k')
  expect(fillLabel({ tokens: 320_000, percent: null })).toBe('ctx 320k · consider /compact')
})
