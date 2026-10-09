import { expect, test } from 'claude-code/testing'

import { parsePalette } from './palette'

test('a palette file overrides the colours it names and keeps defaults for the rest', async () => {
  const p = parsePalette(JSON.stringify({ stops: ['#000000', '#ffffff'], pink: '#ff00ff', bad: 'red' }))

  expect(p.stops).toEqual([0x000000, 0xffffff])
  expect(p.pink).toBe(0xff00ff)
  expect(p.bad).toBe(0xf43f5e)
})

test('fewer than two valid stops falls back to the default gradient', async () => {
  expect(parsePalette(JSON.stringify({ stops: ['#123456'] })).stops.length).toBe(6)
})
