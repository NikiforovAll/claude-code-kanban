import type { Register } from 'claude-code'
import { register as activity } from './activity'
import { register as context } from './context'
import { register as doorbell } from './doorbell'
import { register as show } from './show'

export const register: Register = (on, options) => {
  context(on, options)
  activity(on, options)
  doorbell(on, options)
  show(on, options)
}
