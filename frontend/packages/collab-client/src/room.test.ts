import { describe, expect, it, vi } from 'vitest'

import { openCollabRoom } from './open'
import { adapterAt, fakeServer, join, text } from './test-support'

describe('collab room', () => {
  it('a tab stops following a document a newer editor wrote to, and goes read-only', async () => {
    const server = fakeServer()
    const room = await join(server.endpoints())
    const writer = await join(server.endpoints())
    writer.doc.getText('t').insert(0, 'new')
    await writer.flush()
    server.schema.now = 2

    await room.pull()
    room.doc.getText('t').insert(0, 'mine')
    writer.doc.getText('t').insert(0, 'later')
    await writer.flush()
    await room.pull()

    expect([room.newerSchema, room.canWrite, text(room), room.unsent]).toEqual([
      true,
      false,
      'mine',
      0,
    ])
  })

  it('typing from before a newer editor wrote is still saved', async () => {
    vi.useFakeTimers()
    const server = fakeServer()
    const room = await join(server.endpoints())
    room.doc.getText('t').insert(0, 'kept')
    server.schema.now = 2

    await room.pull()
    await vi.advanceTimersByTimeAsync(1500)

    expect([room.newerSchema, room.saveState, text(await join(server.endpoints()))]).toEqual([
      true,
      'clean',
      'kept',
    ])
  })

  it('a tab opened on a document a newer editor wrote to shows it and sends nothing', async () => {
    const server = fakeServer()
    const writer = await join(server.endpoints())
    writer.doc.getText('t').insert(0, 'new')
    await writer.flush()
    server.schema.now = 2

    const room = await join(server.endpoints())
    room.doc.getText('t').insert(0, 'x')
    await room.flush()

    expect([room.newerSchema, room.canWrite, text(room), room.unsent, server.rows.length]).toEqual([
      true,
      false,
      'xnew',
      0,
      1,
    ])
  })

  it('a tab learns how full the document is when it opens, and again on every pull', async () => {
    const server = fakeServer()
    const [writer, reader] = [await join(server.endpoints()), await join(server.endpoints())]
    writer.doc.getText('t').insert(0, 'alpha ')
    await writer.flush()
    const opened = (await join(server.endpoints())).limits

    await reader.pull()

    const row = server.rows[0].bytes.byteLength
    expect([opened?.tail_bound, reader.limits?.tail_bound, reader.limits?.edit_max]).toEqual([
      row,
      row,
      4 * 2 ** 20,
    ])
  })

  it('a tab opened later sees everything typed before', async () => {
    const server = fakeServer()
    const writer = await join(server.endpoints())
    writer.doc.getText('t').insert(0, 'kept')
    await writer.flush()

    expect(text(await join(server.endpoints()))).toBe('kept')
  })

  it('opens nothing while collaboration is off or the document is not collaborative', async () => {
    for (const state of ['disabled', 'unconverted']) {
      const opened = openCollabRoom({
        endpoints: fakeServer(state).endpoints(),
        principal: 'a@x.com',
        adapter: adapterAt(1),
        signedIn: () => 'a@x.com',
      })
      await expect(opened).resolves.toEqual({
        state,
      })
    }
  })
})
