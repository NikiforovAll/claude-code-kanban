// Finds the swarm viewer, or starts one, and prints its URL for a swarm.
// Run by the swarm-viewer skill.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { configDir } from './files.mjs'

const require = createRequire(import.meta.url)
const { recordFile, liveRecord } = require('../viewer/lib/record.js')

const SERVER = fileURLToPath(new URL('../viewer/server.js', import.meta.url))
const PROBE_MS = 1000
const START_MS = 5000
const POLL_MS = 100
const IDLE_EXIT_MIN = 30
const LOG_CAP = 1024 * 1024
const READY_RE = /running at http:\/\/localhost:(\d+)/

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(readText(file))
  } catch {
    return null
  }
}

async function getJson(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_MS) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

// hub.json and token are the hub's own files (lib/hub-record.js). A hub that lists the swarm app runs the viewer.
async function hubViewer(env) {
  const hubDir = env.CLAUDE_HUB_DIR || path.join(os.homedir(), '.claude-hub')
  const port = readJson(path.join(hubDir, 'hub.json'))?.port
  const token = readText(path.join(hubDir, 'token'))?.trim()
  if (!port || !token) return null
  const url = (await getJson(`http://127.0.0.1:${port}/api/config`, { cookie: `hub_token=${token}` }))?.apps?.swarm?.url
  return url ? { base: url, source: 'hub' } : null
}

// The viewer keeps one instance per config dir: a second start prints the live one's ready line and
// exits, so parallel callers all read the same port. The log is shared, so each caller reads only
// what was appended after its spawn.
async function spawnViewer(config, env, log) {
  const from = fs.existsSync(log) && fs.statSync(log).size < LOG_CAP ? fs.statSync(log).size : 0
  const fd = fs.openSync(log, from ? 'a' : 'w')
  const child = spawn(process.execPath, [SERVER, '--port', '0', '--idle-exit', String(IDLE_EXIT_MIN)], {
    env: { ...env, CLAUDE_CONFIG_DIR: config },
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  child.unref()
  fs.closeSync(fd)
  for (const deadline = Date.now() + START_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    const port = READY_RE.exec(readText(log)?.slice(from) ?? '')?.[1]
    if (port) return { base: `http://localhost:${port}`, source: 'started' }
    if (child.exitCode !== null && child.exitCode !== 0) break
  }
  throw new Error(`the viewer did not start; see ${log}`)
}

export async function viewer({ swarm, env = process.env } = {}) {
  const config = configDir(env)
  fs.mkdirSync(`${config}/.cck`, { recursive: true })
  const recorded = liveRecord(recordFile(config), config)
  const live = async () => {
    const r = await recorded
    return r ? { base: `http://localhost:${r.port}`, source: 'running' } : null
  }
  const { base, source } =
    (await hubViewer(env)) ?? (await live()) ?? (await spawnViewer(config, env, `${config}/.cck/swarm-viewer.log`))
  const url = new URL(base)
  if (swarm) url.searchParams.set('swarm', swarm)
  return { url: url.href, source }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(await viewer({ swarm: process.argv[2] }), null, 2)}\n`)
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exitCode = 1
  }
}
