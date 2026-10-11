// Worker names in the style of Docker's container names: <adjective>-<scientist>.
import { randomInt } from 'node:crypto'

const ADJECTIVES = [
  'bold', 'brave', 'bright', 'calm', 'clever', 'cool', 'eager', 'fair', 'fond', 'gentle',
  'happy', 'keen', 'kind', 'lucid', 'lucky', 'merry', 'modest', 'neat', 'nimble', 'noble',
  'patient', 'proud', 'quick', 'quiet', 'rapid', 'sharp', 'shy', 'sleek', 'steady', 'sunny',
  'swift', 'tidy', 'trusty', 'upbeat', 'vivid', 'warm', 'wise', 'witty', 'zany', 'zen',
]

const SCIENTISTS = [
  'babbage', 'bohr', 'boole', 'curie', 'darwin', 'dijkstra', 'einstein', 'euler', 'faraday', 'fermi',
  'feynman', 'franklin', 'galileo', 'gauss', 'goodall', 'hamilton', 'hopper', 'hubble', 'hypatia', 'kepler',
  'knuth', 'lamarr', 'lovelace', 'maxwell', 'meitner', 'mendel', 'newton', 'noether', 'pascal', 'pasteur',
  'planck', 'ramanujan', 'ritchie', 'sagan', 'shannon', 'tesla', 'thompson', 'torvalds', 'turing', 'wozniak',
]

// n distinct names, none in taken.
export function workerNames(n, taken = new Set(), pick = randomInt) {
  const names = []
  for (let i = 0; names.length < n; i++) {
    if (i >= 1000) throw new Error('no free worker name after 1000 tries')
    const name = `${ADJECTIVES[pick(ADJECTIVES.length)]}-${SCIENTISTS[pick(SCIENTISTS.length)]}`
    if (!taken.has(name) && !names.includes(name)) names.push(name)
  }
  return names
}
