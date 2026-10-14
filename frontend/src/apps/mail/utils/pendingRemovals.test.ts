import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { reference: string; input: unknown }[] = []
vi.mock('@/api', () => ({
  api: {
    mail: { messages: { delete: 'delete', deleteDraft: 'deleteDraft' } },
  },
  client: {
    mutation: vi.fn((reference: string, input: unknown) => {
      calls.push({ reference, input })
      return Promise.resolve()
    }),
  },
}))

const load = () => import('./pendingRemovals')

describe('pending removals', () => {
  beforeEach(() => {
    calls.length = 0
    localStorage.clear()
  })

  it('sends on the next start what a closed page left, once', async () => {
    const { rememberRemoval, resumeRemovals } = await load()
    rememberRemoval({ kind: 'draft', account: 'a', id: 'd1' })
    rememberRemoval({ kind: 'messages', names: ['n1', 'n2'] })

    expect(await resumeRemovals()).toBe(true)
    expect(calls).toEqual([
      { reference: 'deleteDraft', input: { account: 'a', id: 'd1' } },
      { reference: 'delete', input: { names: ['n1', 'n2'] } },
    ])

    calls.length = 0
    expect(await resumeRemovals()).toBe(false)
    expect(calls).toEqual([])
  })

  it('leaves nothing to resume for a removal already settled', async () => {
    const { forgetRemoval, rememberRemoval, resumeRemovals } = await load()
    forgetRemoval(rememberRemoval({ kind: 'draft', account: 'a', id: 'd1' }))
    expect(await resumeRemovals()).toBe(false)
    expect(calls).toEqual([])
  })

  it('sends nothing for a draft that was never saved', async () => {
    const { sendRemoval } = await load()
    await sendRemoval({ kind: 'messages', names: [] })
    expect(calls).toEqual([])
  })
})
