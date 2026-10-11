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
