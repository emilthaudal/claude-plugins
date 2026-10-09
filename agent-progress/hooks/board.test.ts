import { expect, test } from 'claude-code/testing'

import {
  EMPTY,
  agentCalled,
  agentEnded,
  agentLaunched,
  agentStepped,
  agentUsedTool,
  modelLabel,
  parseNotification,
  parseWorkflowMeta,
  progress,
  taskNotified,
  workflowLaunched,
  workflowStarted,
} from './board'

test('model ids read as family and version', async () => {
  expect(modelLabel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
  expect(modelLabel('claude-opus-5-5')).toBe('opus 5.5')
  expect(modelLabel(null)).toBe('')
})

test('workflow meta yields name and phase titles', async () => {
  const script = `export const meta = {
    name: 'review-changes',
    description: 'Review changed files',
    phases: [{ title: 'Review' }, { title: 'Verify', detail: 'adversarial' }],
  }
  const x = agent('hi', { phase: 'Review' })`

  expect(parseWorkflowMeta(script)).toEqual({ name: 'review-changes', phases: ['Review', 'Verify'] })
})

test('task notifications parse id and status', async () => {
  const text = '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>'

  expect(parseNotification(text)).toEqual({ taskId: 'abc123', status: 'completed' })
  expect(parseNotification('hello')).toBeNull()
})

test('a workflow collects its agents and ends on its task notification', async () => {
  let b = workflowStarted(EMPTY, { id: 'w', title: 'review-changes', phases: ['Review', 'Verify'] }, 0)
  b = workflowLaunched(b, 'w', ['task9'], false, 1)
  b = agentStepped(b, { agentId: 'x1', model: 'claude-haiku-4-5', effort: null }, 2)
  b = agentStepped(b, { agentId: 'x2', model: 'claude-haiku-4-5', effort: null }, 2)
  b = agentUsedTool(b, 'x2', 'Grep')
  b = agentEnded(b, 'x1', true, 5)

  expect(b.runs[0]!.strips.map(s => s.label)).toEqual(['agent 1', 'agent 2'])
  expect(b.runs[0]!.strips[1]!.tool).toBe('Grep')
  expect(progress(b.runs[0]!)).toBe(0.5)
  expect(b.runs[0]!.endedAt).toBeNull()

  b = taskNotified(b, 'task9', 'completed', 30)
  expect(b.runs[0]!.status).toBe('done')
  expect(progress(b.runs[0]!)).toBe(1)
})

test('a plain Agent spawn during a workflow stays off its bar', async () => {
  let b = workflowStarted(EMPTY, { id: 'w', title: 'wf', phases: [] }, 0)
  // A synchronous spawn steps before its call answers; a background one names its agent in the answer.
  b = agentCalled(b, 't1')
  b = agentStepped(b, { agentId: 'sync', model: 'claude-sonnet-5-5', effort: null }, 1)
  b = agentCalled(b, 't2')
  b = agentLaunched(b, 't2', 'bg')
  b = agentStepped(b, { agentId: 'bg', model: 'claude-sonnet-5-5', effort: null }, 2)
  b = agentLaunched(b, 't1', 'sync')

  expect(b.runs[0]!.strips).toEqual([])
  expect(b.pending).toEqual([])
  expect(b.agents).toEqual(['sync', 'bg'])

  b = agentEnded(b, 'sync', true, 3)
  b = taskNotified(b, 'bg', 'completed', 4)
  expect(b.agents).toEqual([])
})

test('nothing changed returns the same board, so the band can skip the write', async () => {
  const b = agentLaunched(agentCalled(EMPTY, 't'), 't', 'a1')
  expect(agentUsedTool(b, 'a1', 'Bash')).toBe(b)
  expect(agentStepped(b, { agentId: 'a1', model: 'm', effort: null }, 1)).toBe(b)
  expect(agentStepped(EMPTY, { agentId: 'fork', model: 'claude-haiku-4-5', effort: null }, 1)).toBe(EMPTY)
})
