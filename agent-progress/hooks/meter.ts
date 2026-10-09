// The context window's fill, as a level the band colours by.

export type Fill = { tokens: number; percent: number | null }

export type FillLevel = 'ok' | 'warn' | 'bad'

/** Where the meter turns amber and red, by tokens or by percent of the window, whichever comes first. */
export type Limits = { warnTokens: number; badTokens: number }

// Model steps slow down as the context grows: measured at about 50% slower above 300k tokens than under 50k.
export const DEFAULT_LIMITS: Limits = { warnTokens: 200_000, badTokens: 300_000 }
const WARN_PERCENT = 70
const BAD_PERCENT = 85

export function fillLevel(fill: Fill, limits: Limits = DEFAULT_LIMITS): FillLevel {
  const percent = fill.percent ?? 0
  if (fill.tokens > limits.badTokens || percent >= BAD_PERCENT) return 'bad'
  if (fill.tokens > limits.warnTokens || percent >= WARN_PERCENT) return 'warn'

  return 'ok'
}

export function tokensLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`
}

/** `ctx 62% 124k`, with the hint to compact once it is red. */
export function fillLabel(fill: Fill, limits: Limits = DEFAULT_LIMITS): string {
  const percent = fill.percent === null ? '' : ` ${fill.percent}%`
  const hint = fillLevel(fill, limits) === 'bad' ? ' · consider /compact' : ''

  return `ctx${percent} ${tokensLabel(fill.tokens)}${hint}`
}
