import type { On, SessionMeasureInput } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { displayName, toStatus } from '../hooks/context'

const MEASURE: SessionMeasureInput = {
  context: { tokens: 129_174, window: 1_000_000, percent: 13 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 1, resetsAt: '2026-10-02T13:10:00Z' },
    { kind: 'seven_day', percentUsed: 7.5, resetsAt: '2026-10-09T00:00:00Z' },
  ],
  cost: { usd: 2.71 },
  changed: ['context', 'rateLimits', 'cost'],
}

function engine(on: On, env: Record<string, string>, sessionId: string) {
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path.replaceAll('\\', '/'), text: e.text })
    return { value: undefined }
  })
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: sessionId }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.measure', (_$, e) => ({ changed: [...e.changed] }))
  return writes
}

test('session.measure writes the statusLine shape the board reads', async ($, on) => {
  const writes = engine(on, { CLAUDE_CONFIG_DIR: 'C:/cfg' }, 'sid-1')

  await $.session.measure(MEASURE)

  expect(writes.length).toBe(1)
  expect(writes[0]?.path).toBe('C:/cfg/.cck/context-status/sid-1.json')
  const status = JSON.parse(writes[0]?.text ?? '{}')
  expect(status.model).toEqual({ id: 'claude-opus-5-5', display_name: 'Opus 5.5' })
  expect(status.cost.total_cost_usd).toBe(2.71)
  expect(status.context_window).toEqual({
    total_input_tokens: 129_174,
    context_window_size: 1_000_000,
    current_usage: null,
    used_percentage: 13,
  })
  expect(status.rate_limits.five_hour).toEqual({ used_percentage: 1, resets_at: 1790946600 })
  expect(status.rate_limits.seven_day.used_percentage).toBe(7.5)
})

test('session.measure writes no cache entry before the first request', async ($, on) => {
  const writes = engine(on, { CLAUDE_CONFIG_DIR: 'C:/cfg' }, 'sid-4')

  await $.session.measure(MEASURE)

  expect(JSON.parse(writes[0]?.text ?? '{}').cache).toBeUndefined()
})

test('toStatus adds the last request time', async () => {
  const status = toStatus('claude-opus-5-5', MEASURE, undefined, 1_790_000_000_000)
  expect(status.cache).toEqual({ last_request_at: 1_790_000_000_000 })
})

test('skips a write when the status has not changed', async ($, on) => {
  const writes = engine(on, { CLAUDE_CONFIG_DIR: 'C:/cfg' }, 'sid-3')

  await $.session.measure(MEASURE)
  await $.session.measure(MEASURE)
  await $.session.measure({ ...MEASURE, cost: { usd: 3 } })

  expect(writes.length).toBe(2)
})

test('display name from model id', async () => {
  expect(displayName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(displayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(displayName('claude-fable-5-1[1m]')).toBe('Fable 5.1')
  expect(displayName('claude-opus-4-20250514')).toBe('Opus 4')
  expect(displayName('gpt-x')).toBe('gpt-x')
})

test('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset', async ($, on) => {
  const writes = engine(on, { USERPROFILE: 'C:/Users/me' }, 'sid-2')

  await $.session.measure(MEASURE)

  expect(writes.map(w => w.path)).toEqual(['C:/Users/me/.claude/.cck/context-status/sid-2.json'])
})
