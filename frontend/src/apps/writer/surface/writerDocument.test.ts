import { describe, expect, it } from 'vitest'

import { isLocked } from './writerDocument'

describe('locked documents', () => {
  it('lock a document only while the lock is set', () => {
    expect(isLocked({ lock: true })).toBe(true)
    expect(isLocked({ lock: null })).toBe(false)
    expect(isLocked({})).toBe(false)
  })
})
