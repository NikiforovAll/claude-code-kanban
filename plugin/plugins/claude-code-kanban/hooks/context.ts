import type { EngineInterface, ModelUsage, Register, SessionMeasureInput } from 'claude-code'

type Measure = Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>

export function displayName(model: string) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model)
  if (!m?.[1]) return model
  const family = m[1][0]!.toUpperCase() + m[1].slice(1)
  return `${family} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
}

const toEpochSeconds = (iso?: string) => (iso ? Math.floor(Date.parse(iso) / 1000) : undefined)

// The board reads the statusLine's JSON shape, so the file keeps its field names.
export function toStatus(model: string, m: Measure, usage: ModelUsage | undefined) {
  const { context } = m
  return {
    model: { id: model, display_name: displayName(model) },
    cost: { total_cost_usd: m.cost?.usd ?? 0 },
    context_window: {
      total_input_tokens: context.tokens ?? 0,
      context_window_size: context.window,
      current_usage: usage ?? null,
      used_percentage: context.percent ?? null,
    },
    rate_limits: Object.fromEntries(
      m.rateLimits.map(r => [r.kind, { used_percentage: r.percentUsed, resets_at: toEpochSeconds(r.resetsAt) }]),
    ),
  }
}

async function cckDir($: EngineInterface) {
  const [configDir, home, userProfile] = await Promise.all([
    $.env.get('CLAUDE_CONFIG_DIR'),
    $.env.get('HOME'),
    $.env.get('USERPROFILE'),
  ])
  return configDir ? `${configDir}/.cck` : `${home ?? userProfile}/.claude/.cck`
}

let lastUsage: ModelUsage | undefined
let lastModel: string | undefined
const lastWritten = new Map<string, string>()

async function write($: EngineInterface, m: Measure) {
  const [sessionId, model, dir] = await Promise.all([
    $.session.id(),
    lastModel ?? $.session.model(),
    cckDir($),
  ])
  const text = JSON.stringify(toStatus(model, m, lastUsage))
  const file = `${dir}/context-status/${sessionId}.json`
  if (lastWritten.get(file) === text) return
  await $.fs.write(file, text)
  lastWritten.set(file, text)
}

export const register: Register = on => {
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      const { model, ...usage } = result.usage
      lastUsage = usage
      lastModel = model
      await write($, await $.session.usage())
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    await write($, e)
    return next(e)
  })
}
