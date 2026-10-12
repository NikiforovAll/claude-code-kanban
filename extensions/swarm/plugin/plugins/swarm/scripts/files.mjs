import fs from 'node:fs'

const sleep =(ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// The same formula as hooks/swarm.ts, so the parent and the workers name the same folder.
export const configDir = (env = process.env) =>
  (env.CLAUDE_CONFIG_DIR || `${env.HOME ?? env.USERPROFILE}/.claude`).replaceAll('\\', '/')

// On Windows a rename over a file that a watcher has open fails for a moment.
export function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to)
    } catch (err) {
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
      sleep(20)
    }
  }
}

// The parsed file, or null when it is missing.
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameRetry(tmp, file)
}
