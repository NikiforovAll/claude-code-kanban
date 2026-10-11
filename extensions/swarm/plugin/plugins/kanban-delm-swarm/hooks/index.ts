import type { Register } from 'claude-code'
import { register as swarm } from './swarm'

export const register: Register = (on, options) => {
  swarm(on, options)
}
