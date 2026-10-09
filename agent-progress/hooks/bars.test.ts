import { expect, test } from 'claude-code/testing'

import { barCells, gradient, mix } from './bars'

function decode(cells: string): number[] {
  const bin = atob(cells)
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0))

  return [...new Uint32Array(bytes.buffer)]
}

test('the gradient loops without a seam', async () => {
  expect(gradient(0)).toBe(gradient(1))
  expect(gradient(-0.25)).toBe(gradient(0.75))
  expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080)
})

test('bars fill in proportion', async () => {
  const words = decode(barCells(0.5, 10, 'done', 0))
  const glyphs = words.filter((_, i) => i % 3 === 0)

  expect(words.length).toBe(10 * 3)
  expect(glyphs.filter(cp => cp === 0x2501).length).toBe(5)
})
