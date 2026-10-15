import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, shallowRef } from 'vue'

import type { DocumentThread } from '@/apps/drive'

import { keepSeen, readSeen, useSeenThreads } from './seenThreads'

const scopes: ReturnType<typeof effectScope>[] = []

afterEach(() => {
  for (const scope of scopes.splice(0)) {
    scope.stop()
  }

  vi.restoreAllMocks()
  localStorage.clear()
})

function said(name: string, modified: string) {
  return { name, content: name, modified }
}

function thread(
  name: string,
  comments: object[] = [said(`${name}-1`, '2026-10-01 09:00:00')],
  isResolved = false,
) {
  return { name, resolved: isResolved, comments } as unknown as DocumentThread
}

const FIRST = thread('first')
const SECOND = thread('second')

// The threads as this person sees them on this device, with one open or none
function watchThreads(listed: DocumentThread[], hasLoaded = ref(true)) {
  const threads = shallowRef(listed)
  const open = ref<string | null>(null)
  const scope = effectScope()
  scopes.push(scope)
  const seen = scope.run(() =>
    useSeenThreads({
      user: 'ann',
      node: 'doc-1',
      threads: () => threads.value,
      hasLoaded: () => hasLoaded.value,
      openThread: () => open.value,
    }),
  )!
  function unread() {
    return threads.value.filter(seen.isUnread).map((shown) => shown.name)
  }

  return { threads, open, seen, unread }
}

describe('the marks kept on this device', () => {
  it('reads back what was kept, per person and document', () => {
    keepSeen('ann', 'doc-1', { first: '1::false' })

    expect([readSeen('ann', 'doc-1'), readSeen('ann', 'doc-2'), readSeen('ben', 'doc-1')]).toEqual([
      { first: '1::false' },
      null,
      null,
    ])
  })

  it('reads nothing from words that are not marks, and drops marks that are not text', () => {
    const key = 'suite:writer-seen-threads:ann:doc-1'
    const read: unknown[] = []
    for (const stored of ['{broken', '[]', '"text"', '{"first":"1::false","second":2}']) {
      localStorage.setItem(key, stored)
      read.push(readSeen('ann', 'doc-1'))
    }

    expect(read).toEqual([null, null, null, { first: '1::false' }])
  })

  it('keeps nothing, without throwing, when storage is blocked, and follows this tab alone', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    keepSeen('ann', 'doc-1', { first: '1::false' })
    const { unread, threads } = watchThreads([FIRST])
    threads.value = [thread('first', [said('first-1', '2026-10-02 09:00:00')])]

    expect([readSeen('ann', 'doc-1'), unread()]).toEqual([null, ['first']])
  })
})

describe('which threads changed since last opened', () => {
  it('shows none unread on a document first opened on this device, and keeps that', () => {
    const { unread } = watchThreads([FIRST, SECOND])

    expect([unread(), Object.keys(readSeen('ann', 'doc-1') ?? {})]).toEqual([
      [],
      ['first', 'second'],
    ])
  })

  it('keeps nothing while the threads load or fail to, then starts with every thread seen', async () => {
    const hasLoaded = ref(false)
    const { threads, unread } = watchThreads([], hasLoaded)
    await nextTick()
    const whileLoading = readSeen('ann', 'doc-1')

    threads.value = [FIRST, SECOND]
    hasLoaded.value = true
    await nextTick()

    expect([whileLoading, unread(), Object.keys(readSeen('ann', 'doc-1') ?? {})]).toEqual([
      null,
      [],
      ['first', 'second'],
    ])
  })

  it('shows a thread unread after a new reply, an edit, a deleted comment, a resolve or a reopen', async () => {
    const [opening, reply] = [
      said('first-1', '2026-10-01 09:00:00'),
      said('first-2', '2026-10-01 10:00:00'),
    ]
    const replied = thread('first', [opening, reply])
    const changes = [
      thread('first', [opening, reply, said('first-3', '2026-10-01 11:00:00')]),
      thread('first', [opening, said('first-2', '2026-10-01 11:00:00')]),
      thread('first', [reply]),
      thread('first', replied.comments, true),
    ]
    const seenAs: string[][] = []
    for (const changed of changes) {
      const { threads, unread } = watchThreads([replied])
      threads.value = [changed]
      await nextTick()
      seenAs.push(unread())
      localStorage.clear()
    }

    const { threads, unread } = watchThreads([thread('first', FIRST.comments, true)])
    threads.value = [FIRST]
    seenAs.push(unread())

    expect(seenAs).toEqual([['first'], ['first'], ['first'], ['first'], ['first']])
  })

  it('shows a thread started since unread, and the others as they were', () => {
    watchThreads([FIRST])

    const { unread } = watchThreads([FIRST, SECOND])

    expect(unread()).toEqual(['second'])
  })

  it('keeps the open thread seen as replies arrive, and clears one once opened', async () => {
    const { threads, open, unread } = watchThreads([FIRST, SECOND])
    open.value = 'first'
    await nextTick()

    threads.value = [
      thread('first', [...FIRST.comments, said('first-2', '2026-10-01 10:00:00')]),
      thread('second', [...SECOND.comments, said('second-2', '2026-10-01 10:00:00')]),
    ]
    await nextTick()
    const whileOpen = unread()
    open.value = 'second'
    await nextTick()

    expect([whileOpen, unread()]).toEqual([['second'], []])
  })

  it('keeps a thread seen across a reload once opened, and forgets threads gone from the list', async () => {
    const { threads, seen } = watchThreads([FIRST, SECOND])
    threads.value = [thread('first', [...FIRST.comments, said('first-2', '2026-10-01 10:00:00')])]

    seen.markSeen('first')
    const { unread } = watchThreads(threads.value)

    expect([unread(), Object.keys(readSeen('ann', 'doc-1') ?? {})]).toEqual([[], ['first']])
  })

  it('clears a thread here once another tab on this device opens it', () => {
    const { threads, unread } = watchThreads([FIRST])
    threads.value = [thread('first', [...FIRST.comments, said('first-2', '2026-10-01 10:00:00')])]
    const before = unread()
    const { seen: otherTab } = watchThreads(threads.value)
    const oldValue = localStorage.getItem('suite:writer-seen-threads:ann:doc-1')

    otherTab.markSeen('first')
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'suite:writer-seen-threads:ann:doc-1',
        oldValue,
        newValue: localStorage.getItem('suite:writer-seen-threads:ann:doc-1'),
      }),
    )

    expect([before, unread()]).toEqual([['first'], []])
  })

  it('keeps its marks when another document’s marks change on this device', () => {
    const { unread } = watchThreads([FIRST])

    window.dispatchEvent(
      new StorageEvent('storage', { key: 'suite:writer-seen-threads:ann:doc-2', newValue: '{}' }),
    )

    expect(unread()).toEqual([])
  })
})
