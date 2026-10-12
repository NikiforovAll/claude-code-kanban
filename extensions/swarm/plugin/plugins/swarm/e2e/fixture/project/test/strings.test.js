import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slugify } from '../src/slugify.js'
import { titleCase } from '../src/title-case.js'

test('slugify', () => {
  assert.equal(slugify('  Hello, World!  '), 'hello-world')
  assert.equal(slugify('Déjà vu 2'), 'deja-vu-2')
  assert.equal(slugify('---'), '')
})

test('titleCase', () => {
  assert.equal(titleCase('the quick brown fox'), 'The Quick Brown Fox')
  assert.equal(titleCase('  many   spaces '), 'Many Spaces')
  assert.equal(titleCase(''), '')
})
