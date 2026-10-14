import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('pending removals', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    calls.length = 0
    localStorage.clear()
  })
  afterEach(() => vi.useRealTimers())

  it('sends what a closed page left once its Undo window is over, and only once', async () => {
    const { rememberRemoval, resumeRemovals } = await load()
    rememberRemoval({ kind: 'draft', account: 'a', id: 'd1' })
    rememberRemoval({ kind: 'messages', names: ['n1', 'n2'] })
    vi.advanceTimersByTime(60_000)

    const onSent = vi.fn()
    await resumeRemovals(onSent)
    expect(calls).toEqual([
      { reference: 'deleteDraft', input: { account: 'a', id: 'd1' } },
      { reference: 'delete', input: { names: ['n1', 'n2'] } },
    ])
    expect(onSent).toHaveBeenCalledOnce()

    calls.length = 0
    await resumeRemovals()
    expect(calls).toEqual([])
  })

  it('leaves a removal another tab may still undo, and sends it once it is abandoned', async () => {
    const { rememberRemoval, resumeRemovals } = await load()
    rememberRemoval({ kind: 'draft', account: 'a', id: 'd1' })

    await resumeRemovals()
    expect(calls).toEqual([])

    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(calls).toEqual([{ reference: 'deleteDraft', input: { account: 'a', id: 'd1' } }])
  })

  it('sends nothing for a removal the other tab settled in its window', async () => {
    const { forgetRemoval, rememberRemoval, resumeRemovals } = await load()
    const key = rememberRemoval({ kind: 'draft', account: 'a', id: 'd1' })
    await resumeRemovals()
    forgetRemoval(key)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toEqual([])
  })

  it('sends a removal written before removals carried a due time', async () => {
    const { resumeRemovals } = await load()
    localStorage.setItem(
      'suite.mail.pendingRemovals',
      JSON.stringify({ old: { kind: 'draft', account: 'a', id: 'd1' } }),
    )
    await resumeRemovals()
    expect(calls).toEqual([{ reference: 'deleteDraft', input: { account: 'a', id: 'd1' } }])
  })

  it('sends nothing for a draft that was never saved', async () => {
    const { sendRemoval } = await load()
    await sendRemoval({ kind: 'messages', names: [] })
    expect(calls).toEqual([])
  })
})
