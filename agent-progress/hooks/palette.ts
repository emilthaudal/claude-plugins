// The band's colours. A JSON file (the `paletteFile` option) can override any of them, so a status line script can
// read the same file and the two match.

export type Palette = {
  stops: number[]
  lavender: number
  muted: number
  rule: number
  pink: number
  purple: number
  blue: number
  cyan: number
  ok: number
  warn: number
  bad: number
}

const DEFAULT: Palette = {
  stops: [0x7c3aed, 0xc026d3, 0xec4899, 0x8b5cf6, 0x3b82f6, 0x22d3ee],
  lavender: 0xc4b5fd,
  muted: 0x7c6aa6,
  rule: 0x4c3a78,
  pink: 0xec4899,
  purple: 0xa78bfa,
  blue: 0x60a5fa,
  cyan: 0x22d3ee,
  ok: 0x34d399,
  warn: 0xfbbf24,
  bad: 0xf43f5e,
}

let current: Palette = DEFAULT

export function palette(): Palette {
  return current
}

function color(value: unknown, fallback: number): number {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? parseInt(value.slice(1), 16) : fallback
}

export function parsePalette(text: string): Palette {
  const raw = JSON.parse(text) as Record<string, unknown>
  const stops = Array.isArray(raw.stops) ? raw.stops.map(s => color(s, -1)).filter(n => n >= 0) : []
  const pick = (key: Exclude<keyof Palette, 'stops'>) => color(raw[key], DEFAULT[key])

  return {
    stops: stops.length >= 2 ? stops : DEFAULT.stops,
    lavender: pick('lavender'),
    muted: pick('muted'),
    rule: pick('rule'),
    pink: pick('pink'),
    purple: pick('purple'),
    blue: pick('blue'),
    cyan: pick('cyan'),
    ok: pick('ok'),
    warn: pick('warn'),
    bad: pick('bad'),
  }
}

export function setPalette(next: Palette) {
  current = next
}
