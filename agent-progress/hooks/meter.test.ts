import { expect, test } from 'claude-code/testing'

import { fillLabel, fillLevel, tokensLabel } from './meter'

test('context fill turns amber past 200k or 70%, red past 300k or 85%', async () => {
  expect(fillLevel({ tokens: 120_000, percent: 12 })).toBe('ok')
  expect(fillLevel({ tokens: 210_000, percent: 21 })).toBe('warn')
  expect(fillLevel({ tokens: 140_000, percent: 70 })).toBe('warn')
  expect(fillLevel({ tokens: 310_000, percent: 31 })).toBe('bad')
  expect(fillLevel({ tokens: 170_000, percent: 85 })).toBe('bad')
  expect(fillLevel({ tokens: 90_000, percent: null })).toBe('ok')
  expect(fillLevel({ tokens: 90_000, percent: 9 }, { warnTokens: 50_000, badTokens: 80_000 })).toBe('bad')
})

test('the label shows percent and tokens, and suggests /compact once red', async () => {
  expect(tokensLabel(124_400)).toBe('124k')
  expect(tokensLabel(1_250_000)).toBe('1.3M')
  expect(fillLabel({ tokens: 124_400, percent: 62 })).toBe('ctx 62% 124k')
  expect(fillLabel({ tokens: 320_000, percent: null })).toBe('ctx 320k · consider /compact')
})
