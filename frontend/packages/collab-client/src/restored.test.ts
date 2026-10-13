import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { device, fakeServer, fakeTime, idle, join, text, type FakeServer } from './test-support'
import type { CollabRoom } from './types'

// The update another tab's restore sends: the document as the server holds it, made `version`
function restoreTo(server: FakeServer, version: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.mergeUpdates(server.rows.map((row) => row.bytes)))
  const before = Y.encodeStateVector(doc)
  const body = doc.getText('t')
  body.delete(0, body.length)
  body.insert(0, version)
  return Y.encodeStateAsUpdate(doc, before)
}

function type(room: CollabRoom, word: string) {
  const body = room.doc.getText('t')
  body.insert(body.length, word)
}

async function serverWith(word: string) {
  const server = fakeServer()
  const writer = await join(server.endpoints())
  type(writer, word)
  await writer.flush()
  return server
}

async function reasonsKept(kept: Awaited<ReturnType<typeof device>>) {
  return (await kept.store.recovery('D')).map((copy) => copy.reason)
}

describe('work from before a restore', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a live tab keeps what it typed before the restore as a recovery copy and is rebuilt', async () => {
    fakeTime()
    const server = await serverWith('draft')
    const kept = await device()
    const room = await join(server.endpoints(), { device: kept, socket: server.socket() })
    await vi.advanceTimersByTimeAsync(0)

    type(room, ' mine')
    server.fence(120_000)
    await vi.advanceTimersByTimeAsync(200)
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    server.landRestore(restoreTo(server, 'old'))
    // Before the pull a notice spreads, and before the paused push is tried again
    await vi.advanceTimersByTimeAsync(10)
    await idle()

    expect([room.stopped, room.needsRebuild]).toEqual(['restored', true])
    expect(await reasonsKept(kept)).toEqual(['restored'])
    expect(text(await join(server.endpoints()))).toBe('old')
  })

  it('a polling tab stops at the pull that tells it of the restore, before showing it over its work', async () => {
    fakeTime()
    const server = await serverWith('draft')
    const kept = await device()
    const room = await join(server.endpoints(), { device: kept })

    type(room, ' mine')
    server.fence(120_000)
    await vi.advanceTimersByTimeAsync(0)
    server.landRestore(restoreTo(server, 'old'))
    await room.pull()
    await vi.waitFor(() => expect(room.needsRebuild).toBe(true))

    expect([room.stopped, text(room)]).toEqual(['restored', 'draft mine'])
    expect(await reasonsKept(kept)).toEqual(['restored'])
  })

  it('work typed before a restore is refused even once the tab shows the restore', async () => {
    fakeTime()
    const server = await serverWith('draft')
    const kept = await device()
    const room = await join(server.endpoints(), { device: kept, socket: server.socket() })
    await vi.advanceTimersByTimeAsync(0)
    type(room, ' mine')
    server.fence(120_000)
    await vi.advanceTimersByTimeAsync(200)

    server.landRestore(restoreTo(server, 'old'), true)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(room.needsRebuild).toBe(true))

    expect([room.appliedThrough, room.stopped, await reasonsKept(kept)]).toEqual([
      2,
      'restored',
      ['restored'],
    ])
    expect(text(await join(server.endpoints()))).toBe('old')
  })

  it('work sent by a tab that heard nothing of the restore is refused and kept', async () => {
    fakeTime()
    const server = await serverWith('draft')
    const kept = await device()
    const room = await join(server.endpoints(), { device: kept })
    server.landRestore(restoreTo(server, 'old'))

    type(room, ' mine')
    await room.flush()
    await vi.waitFor(() => expect(room.needsRebuild).toBe(true))

    expect([room.stopped, await reasonsKept(kept)]).toEqual(['restored', ['restored']])
    expect(text(await join(server.endpoints()))).toBe('old')
  })

  it('work a closed tab left on the device from before the restore is kept aside, not shown', async () => {
    fakeTime()
    const server = await serverWith('draft')
    const kept = await device()
    const first = await join(server.endpoints(), { device: kept })
    server.access.online = false
    type(first, ' offline')
    await vi.advanceTimersByTimeAsync(0)
    await first.close()
    server.access.online = true
    server.landRestore(restoreTo(server, 'old'))

    const next = await join(server.endpoints(), { device: kept })
    await next.flush()

    expect([text(next), next.stopped, next.unsent]).toEqual(['old', null, 0])
    expect(await reasonsKept(kept)).toEqual(['restored'])
    expect(text(await join(server.endpoints()))).toBe('old')
  })

  it('a tab with nothing unsent takes the restore and keeps editing', async () => {
    fakeTime()
    const server = await serverWith('draft')
    const room = await join(server.endpoints(), { socket: server.socket() })
    await vi.advanceTimersByTimeAsync(0)
    server.fence(120_000)
    await vi.advanceTimersByTimeAsync(200)

    server.landRestore(restoreTo(server, 'old'))
    await vi.advanceTimersByTimeAsync(2_000)
    type(room, ' new')
    await room.flush()

    expect([text(room), room.stopped, room.canWrite, room.unsent]).toEqual([
      'old new',
      null,
      true,
      0,
    ])
    expect(text(await join(server.endpoints()))).toBe('old new')
  })
})
