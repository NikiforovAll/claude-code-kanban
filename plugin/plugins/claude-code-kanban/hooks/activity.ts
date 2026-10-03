import type { EngineInterface, Register, ToolCallArgs } from 'claude-code'
import { cckRoot } from './context'

// Mods cannot delete files. The server reads any status but "waiting" as no ask.
export const CLEARED = JSON.stringify({ status: 'cleared' })

export const BOARD_ALLOWED = 'Approved from the board — running'

const POLL_MS = 500

type Kind = 'permission' | 'question' | 'plan'
type Ask = { id: string; kind: Kind; dir: string; waitMs?: number }
type Decision = {
  behavior?: 'allow' | 'deny'
  message?: string
  updatedInput?: Record<string, unknown>
  answers?: Record<string, unknown>
}

// tool.check carries the call's id on a real call only, so a call without one is found by its input.
const pending = new Set<{ id?: string; tool: string; args: Record<string, unknown>; asked: (ask: Ask) => void }>()
// The board's allow runs the tool again through $.tool.call, and its tool.check must not ask twice.
const allowOnce = new Set<string>()
const callKey = (tool: string, input: unknown) => `${tool}\0${JSON.stringify(input)}`

let cck: Promise<string> | undefined

// The engine does not follow $ into an imported function, so only the path rule is shared.
function cckDir($: EngineInterface) {
  cck ??= Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME'), $.env.get('USERPROFILE')]).then(
    ([configDir, home, userProfile]) => cckRoot(configDir, home, userProfile),
  )
  return cck
}

async function readText($: EngineInterface, path: string) {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse((await readText($, path)) ?? '')
  } catch {
    return undefined
  }
}

// The server folds an agent's lines last-key-wins, so a line leaves out a field it does not know.
async function appendLine($: EngineInterface, path: string, record: object, { onlyIfExists = false } = {}) {
  const text = await readText($, path)
  if (text === undefined && onlyIfExists) return
  await $.fs.write(path, `${text ?? ''}${JSON.stringify(record)}\n`)
}

async function sessionDir($: EngineInterface) {
  const [dir, id] = await Promise.all([cckDir($), $.session.id()])
  return `${dir}/agent-activity/${id}`
}

const kindOf = (tool: string): Kind =>
  tool === 'AskUserQuestion' ? 'question' : tool === 'ExitPlanMode' ? 'plan' : 'permission'

// Mirrors approvalsFrom and isKindGated in lib/approvals.js: the gate is on unless config.json
// says enabled: false, and a missing or broken file means the defaults.
async function boardWaitMs($: EngineInterface, kind: Kind) {
  type Approvals = { enabled?: unknown; mode?: unknown; waitSeconds?: unknown }
  const a = (await readJson<{ approvals?: Approvals }>($, `${await cckDir($)}/config.json`))?.approvals ?? {}
  if (a.enabled === false) return undefined
  if (kind === 'question' && a.mode === 'permission') return undefined
  const seconds = Number.isInteger(a.waitSeconds) && (a.waitSeconds as number) >= 0 ? (a.waitSeconds as number) : 1800
  return Math.min(seconds, 1800) * 1000
}

// The marker shows the ask on the board whether or not the board may answer it.
async function openAsk($: EngineInterface, tool: string, input: unknown, rule?: string): Promise<Ask> {
  const kind = kindOf(tool)
  const id = crypto.randomUUID()
  const [dir, cwd, waitMs] = await Promise.all([sessionDir($), $.session.cwd(), boardWaitMs($, kind)])
  await $.fs.write(
    `${dir}/_waiting.json`,
    JSON.stringify({
      status: 'waiting',
      kind,
      id,
      toolName: tool,
      toolInput: JSON.stringify(input),
      cwd,
      rule,
      timestamp: new Date().toISOString(),
    }),
  )
  return { id, kind, dir, waitMs }
}

// A newer ask (a parallel call) may own the marker by now.
async function closeAsk($: EngineInterface, ask: Ask) {
  const marker = `${ask.dir}/_waiting.json`
  if ((await readJson<{ id?: string }>($, marker))?.id === ask.id) await $.fs.write(marker, CLEARED)
}

async function boardDecision($: EngineInterface, ask: Ask, signal: AbortSignal) {
  const file = `${ask.dir}/_decision-${ask.id}.json`
  for (let waited = 0; waited < (ask.waitMs ?? 0); waited += POLL_MS) {
    try {
      await $.clock.sleep(POLL_MS, { signal })
    } catch {
      return undefined
    }
    const d = await readJson<Decision>($, file)
    if (d) return d
  }
  return undefined
}

// Only returning ends the terminal prompt, so an allow runs the tool again from here. A terminal
// "Yes" in the moment before the hook returns runs it twice (docs/ui-approvals.md).
async function answerFromBoard($: EngineInterface, tool: string, args: Record<string, unknown>, ask: Ask, d: Decision) {
  if (ask.kind === 'question') {
    return d.answers ? { result: { questions: args.questions, answers: d.answers } } : undefined
  }
  if (d.behavior !== 'allow') return { deny: d.message ?? 'Denied from the board' }
  $.ui.status(BOARD_ALLOWED)
  const input = { ...args, ...d.updatedInput }
  const key = callKey(tool, input)
  allowOnce.add(key)
  try {
    return await $.tool.call({ ...input, tool } as ToolCallArgs)
  } finally {
    allowOnce.delete(key)
    $.ui.status(undefined)
  }
}

async function mapTaskList($: EngineInterface, cwd: string) {
  const taskListId = await $.env.get('CLAUDE_CODE_TASK_LIST_ID')
  if (!taskListId) return
  const path = `${await cckDir($)}/agent-activity/_task-maps/${taskListId}.json`
  const maps = (await readJson<Record<string, unknown>>($, path)) ?? {}
  maps[await $.session.id()] = { project: cwd, updatedAt: new Date().toISOString() }
  await $.fs.write(path, JSON.stringify(maps))
}

async function markStopped($: EngineInterface) {
  await $.fs.write(`${await sessionDir($)}/_stop.json`, '')
}

// The name map lets TeammateIdle, which names the teammate, find its agent id.
async function agentStarted($: EngineInterface, agentId: string, type: string, name?: string) {
  const dir = await sessionDir($)
  const ts = new Date().toISOString()
  await Promise.all([
    appendLine($, `${dir}/${agentId}.jsonl`, {
      agentId,
      type,
      event: 'start',
      status: 'active',
      startedAt: ts,
      updatedAt: ts,
    }),
    $.fs.write(`${dir}/_name-${name ?? type}.id`, agentId),
  ])
}

// turn.complete also ends loops agent.spawn never started (internal agents): those have no file.
async function agentStopped($: EngineInterface, agentId: string, lastMessage: string) {
  const ts = new Date().toISOString()
  await appendLine(
    $,
    `${await sessionDir($)}/${agentId}.jsonl`,
    {
      agentId,
      event: 'stop',
      status: 'stopped',
      ...(lastMessage && { lastMessage }),
      stoppedAt: ts,
      updatedAt: ts,
    },
    { onlyIfExists: true },
  )
}

// TeammateIdle names the teammate but carries no agent_id outside the teammate's own loop.
async function teammateIdle($: EngineInterface, name: string, agentId?: string, agentType?: string) {
  const dir = await sessionDir($)
  const id = agentId || (await readText($, `${dir}/_name-${name}.id`))
  if (!id) return
  const type = agentId ? agentType : name
  await appendLine(
    $,
    `${dir}/${id}.jsonl`,
    {
      agentId: id,
      ...(type && { type }),
      event: 'idle',
      status: 'idle',
      updatedAt: new Date().toISOString(),
    },
    { onlyIfExists: !type },
  )
}

export const register: Register = on => {
  on('tool.check', async ($, e, next) => {
    if (allowOnce.delete(callKey(e.tool, e.input))) return { decision: 'allow' }
    const result = await next(e)
    if (result.decision !== 'ask') return result
    const input = e.tool_use_id ? undefined : JSON.stringify(e.input)
    const call = [...pending].find(p =>
      e.tool_use_id ? p.id === e.tool_use_id : p.tool === e.tool && JSON.stringify(p.args) === input,
    )
    call?.asked(await openAsk($, e.tool, e.input, result.rule))
    return result
  })
  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id, agentId: _agentId, consent: _consent, ...args } = e as typeof e & { consent?: unknown }
    let asked: (ask: Ask) => void = () => {}
    const ask = new Promise<Ask>(resolve => {
      asked = resolve
    })
    const call = { id: tool_use_id, tool, args, asked }
    pending.add(call)
    const run = next(e)
    const settled = new AbortController()
    const done = run.then(() => undefined).finally(() => settled.abort())
    try {
      const opened = await Promise.race([done, ask])
      if (!opened) return await run
      try {
        const d = await Promise.race([
          done,
          boardDecision($, opened, AbortSignal.any([next.signal, settled.signal])),
        ])
        return (d && (await answerFromBoard($, tool, args, opened, d))) ?? (await run)
      } finally {
        await closeAsk($, opened)
      }
    } finally {
      pending.delete(call)
    }
  })
  on('session.start', async ($, e, next) => {
    await mapTaskList($, e.cwd)
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId) await agentStarted($, result.agentId, e.subagentType, e.name)
    return result
  })
  // An interrupted turn fires no Stop hook, so it does not mark the session unread either.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) await agentStopped($, e.agentId, e.answer)
    else if (!e.isAborted) await markStopped($)
    return next(e)
  })
  // Managed settings bypass user-tier mods on classic.* (cc-plugin-sec-default), so this one
  // has no effect there; there is no native teammate-idle event to use instead.
  on('classic.TeammateIdle', async ($, e, next) => {
    await teammateIdle($, e.teammate_name, e.agent_id, e.agent_type)
    return next(e)
  })
}
