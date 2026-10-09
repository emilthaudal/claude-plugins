// The workflow progress bars, drawn as terminal cells so they can shimmer by blit without a redraw.

import { palette } from './palette'

const DEFAULT = 0x01000000

export function mix(a: number, b: number, f: number): number {
  const ch = (c: number, s: number) => (c >> s) & 0xff
  const lerp = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * f)

  return (lerp(16) << 16) | (lerp(8) << 8) | lerp(0)
}

export function scale(color: number, factor: number): number {
  const ch = (s: number) => Math.min(255, Math.round(((color >> s) & 0xff) * factor))

  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

// The stops close into a loop, so a gradient shifted by any phase wraps without a seam.
export function gradient(t: number): number {
  const stops = palette().stops
  const loop = [...stops, stops[0]!]
  const u = ((t % 1) + 1) % 1
  const span = u * (loop.length - 1)
  const i = Math.floor(span)

  return mix(loop[i]!, loop[i + 1]!, span - i)
}

export function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }

  return out
}

// A Raster's cells: three words per cell (code point, foreground, background), base64 encoded.
function grid(columns: number, rows: number) {
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) {
    words[i * 3] = 0x20
    words[i * 3 + 1] = DEFAULT
    words[i * 3 + 2] = DEFAULT
  }
  const put = (x: number, y: number, cp: number, fg: number, bg: number = DEFAULT) => {
    if (x < 0 || x >= columns || y < 0 || y >= rows) return
    const i = (y * columns + x) * 3
    words[i] = cp
    words[i + 1] = fg
    words[i + 2] = bg
  }

  return { put, cells: () => base64(new Uint8Array(words.buffer)) }
}

/** One row of bar: the done part in the gradient (a light sweeping across it while it runs), the rest a faint rule. */
export function barCells(fraction: number, columns: number, status: 'running' | 'done' | 'failed', tick: number): string {
  const { put, cells } = grid(columns, 1)
  const filled = fraction * columns
  for (let x = 0; x < columns; x++) {
    const pos = x / Math.max(1, columns - 1)
    if (x < Math.floor(filled)) {
      const base = status === 'running' ? gradient(pos * 0.6 - tick * 0.01) : status === 'done' ? mix(palette().ok, gradient(pos * 0.6), 0.25) : palette().bad
      const sweep = status === 'running' ? Math.max(0, 1 - Math.abs(x - ((tick * 0.8) % (columns + 16) - 8)) / 4) : 0
      put(x, 0, 0x2501, mix(base, 0xffffff, sweep * 0.6))
    } else if (x === Math.floor(filled) && status === 'running') {
      put(x, 0, 0x257a, scale(gradient(pos * 0.6 - tick * 0.01), 0.8))
    } else {
      put(x, 0, 0x2500, scale(gradient(pos * 0.6), 0.22))
    }
  }

  return cells()
}
