import { describe, expect, test } from 'bun:test'
import { aittEnv } from '../../src/shared/env'

describe('aittEnv', () => {
  test('reads AITT_*; empty counts as unset', () => {
    expect(aittEnv('HOME', { AITT_HOME: '/a' })).toBe('/a')
    expect(aittEnv('PORT', { AITT_PORT: '' })).toBeUndefined()
    expect(aittEnv('PORT', {})).toBeUndefined()
  })
})
