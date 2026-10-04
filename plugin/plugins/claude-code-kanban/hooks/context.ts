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
export function toStatus(model: string, m: Measure, usage: ModelUsage | undefined, requestAt?: number) {
  const { context } = m
  return {
    ...(requestAt && { cache: { last_request_at: requestAt } }),
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

export const cckRoot = (configDir?: string, home?: string, userProfile?: string) =>
  configDir ? `${configDir}/.cck` : `${home ?? userProfile}/.claude/.cck`

let cck: Promise<string> | undefined

function cckDir($: EngineInterface) {
  cck ??= Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME'), $.env.get('USERPROFILE')]).then(
    ([configDir, home, userProfile]) => cckRoot(configDir, home, userProfile),
  )
  return cck
}

// Keyed by session id: `/clear` keeps the process and changes the id.
const sessions = new Map<string, { req?: { usage: ModelUsage; model: string; at: number }; written?: string }>()

async function write($: EngineInterface, m: Measure, id?: string) {
  const [sessionId, dir] = await Promise.all([id ?? $.session.id(), cckDir($)])
  const s = sessions.get(sessionId) ?? {}
  const model = s.req?.model ?? (await $.session.model())
  const text = JSON.stringify(toStatus(model, m, s.req?.usage, s.req?.at))
  if (s.written === text) return
  await $.fs.write(`${dir}/context-status/${sessionId}.json`, text)
  sessions.set(sessionId, { ...s, written: text })
}

export const register: Register = on => {
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      const { model, ...usage } = result.usage
      const sessionId = await $.session.id()
      sessions.set(sessionId, { ...sessions.get(sessionId), req: { usage, model, at: Date.now() } })
      await write($, await $.session.usage(), sessionId)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    await write($, e)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    sessions.delete(e.sessionId)
    return next(e)
  })
}
