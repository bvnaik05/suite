import type { RestoreResult } from '@suite/collab-client'
import { getSchema } from '@tiptap/core'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { BODY_FIELD } from '@/apps/writer/collab'
import { writerSchema } from '@/apps/writer/schema'

import { restoreVersion } from './restoreVersion'

const schema = getSchema(writerSchema())

// A room that runs the restore's edit and answers `result`
function fakeRoom(result: RestoreResult) {
  return {
    doc: new Y.Doc(),
    lineage: 'one',
    flush: vi.fn(() => Promise.resolve()),
    restoreVersion: vi.fn(async (_seq: number, edit: () => void) => {
      edit()
      return result
    }),
  }
}

function html(value: string) {
  return new TextEncoder().encode(value)
}

function shown(doc: Y.Doc) {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(BODY_FIELD))
  return schema.nodeFromJSON(json).textContent
}

describe('restoreVersion', () => {
  it('saves first, then makes the document the version', async () => {
    const room = fakeRoom({ outcome: 'landed' })

    const notice = await restoreVersion(room, 4, html('<p>back then</p>'))

    expect(notice).toEqual({ isRestored: true, message: 'Version restored' })
    expect([
      room.flush.mock.invocationCallOrder[0] < room.restoreVersion.mock.invocationCallOrder[0],
      room.restoreVersion.mock.calls[0][0],
      shown(room.doc),
    ]).toEqual([true, 4, 'back then'])
  })

  it('never begins a restore of bytes it cannot read', async () => {
    const room = fakeRoom({ outcome: 'landed' })

    const notice = await restoreVersion(room, 4, new Uint8Array([0xff, 0xfe]))

    expect([notice.isRestored, notice.message, room.restoreVersion.mock.calls.length]).toEqual([
      false,
      "This version can't be restored.",
      0,
    ])
  })

  it.each([
    [{ outcome: 'unchanged' }, true, 'The document already matches this version.'],
    [{ outcome: 'unsent' }, false, 'Your changes are still saving. Try again in a moment.'],
    [
      { outcome: 'refused', refusal: 'restore_recent', retryS: 42 },
      false,
      'A restore just ran. Try again in 42 seconds.',
    ],
    [
      { outcome: 'refused', refusal: 'restoring' },
      false,
      'Someone else is restoring a version. Try again once it is done.',
    ],
    [
      { outcome: 'refused', refusal: 'milestone_failed' },
      false,
      "The document as it is now couldn't be kept as a version first, so nothing was restored.",
    ],
    [{ outcome: 'refused' }, false, 'The version was not restored.'],
  ] as [RestoreResult, boolean, string][])(
    'tells the person how %o went',
    async (result, isRestored, message) => {
      const notice = await restoreVersion(fakeRoom(result), 4, html('<p>x</p>'))

      expect(notice).toEqual({ isRestored, message })
    },
  )
})
