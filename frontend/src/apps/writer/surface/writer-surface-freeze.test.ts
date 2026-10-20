import { fromUint8Array } from 'js-base64'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { Doc, encodeStateAsUpdate, XmlElement, XmlText } from 'yjs'

import { oldEditor, realEditors, stored } from './writer-surface-fakes'
import {
  buttonLabelled,
  discardCopies,
  liveRoom,
  oneVersion,
  openedSurface,
  previewAndReturn,
  REFUSED_KEPT,
  resetSurface,
  settled,
  stripTexts,
} from './writer-surface-fixtures'

vi.hoisted(() => {
  vi.stubGlobal('__SUITE_BUILD__', '100')
  vi.stubEnv('DEV', false)
})

vi.mock('frappe-ui', async () => (await import('./writer-surface-fakes')).fakeFrappeUi())
vi.mock('@/apps/drive', async () => (await import('./writer-surface-fakes')).fakeDrive())
vi.mock('y-webrtc', async () => (await import('./writer-surface-fakes')).fakeWebrtc())
vi.mock('@/apps/writer/components/CoreEditor.vue', async () =>
  (await import('./writer-surface-fakes')).fakeCoreEditor(),
)
vi.mock('@/apps/writer/collab', () => ({
  BODY_FIELD: 'default',
}))
vi.mock('@/platform/collab', async () =>
  (await import('./writer-surface-fakes')).fakeCollabPlatform(),
)
vi.mock('@/apps/writer/components/NonCollabEditor.vue', async () =>
  (await import('./writer-surface-fakes')).fakeNonCollabEditor(),
)
vi.mock('./writerDocument', async (importOriginal) => {
  const { fakeWriterDocument } = await import('./writer-surface-fakes')
  return fakeWriterDocument(await importOriginal<typeof import('./writerDocument')>())
})
vi.mock('@/apps/writer/components/CollabTextEditor.vue', async (importOriginal) => {
  const { fakeCollabTextEditor } = await import('./writer-surface-fakes')
  const real =
    await importOriginal<typeof import('@/apps/writer/components/CollabTextEditor.vue')>()
  return fakeCollabTextEditor(real)
})
vi.mock('@/apps/writer/components/TextEditor.vue', async (importOriginal) => {
  const { fakeTextEditor } = await import('./writer-surface-fakes')
  const real = await importOriginal<typeof import('@/apps/writer/components/TextEditor.vue')>()
  return fakeTextEditor(real)
})
vi.mock('@/apps/writer/components/UsersBar.vue', () => ({ default: { render: () => null } }))
vi.mock('./WriterDocumentMenu.vue', async () =>
  (await import('./writer-surface-fakes')).fakeDocumentMenu(),
)
vi.mock('@/apps/writer/composables/useUsers', async (importOriginal) => {
  const { fakeUsers } = await import('./writer-surface-fakes')
  return fakeUsers(await importOriginal<typeof import('@/apps/writer/composables/useUsers')>())
})
vi.mock('./VersionPreview.vue', async () =>
  (await import('./writer-surface-fakes')).fakeVersionPreview(),
)

afterEach(resetSurface)

const FROZEN = "Part of this document can't be shown here, so editing is paused to keep it safe."

// A live room whose body holds text this editor can't show, so the editor freezes on open
function frozenRoom() {
  const room = liveRoom()
  room.doc.getXmlFragment('default').insert(0, [unknownBlock()])
  return room
}

// A block of a kind Writer doesn't have, holding text
function unknownBlock() {
  const block = new XmlElement('mystery')
  block.insert(0, [new XmlText('Kept')])
  return block
}

describe('Writer surface', () => {
  it("shows the freeze strip with Reload when the document holds text the editor can't show", async () => {
    frozenRoom()
    const root = await openedSurface()

    await vi.waitFor(() => expect(stripTexts(root)).toEqual([FROZEN]))
    const [page, reload] = [location, vi.fn()]
    vi.stubGlobal('location', { ...page, reload })
    buttonLabelled(root, 'Reload')!.click()
    vi.stubGlobal('location', page)

    expect(reload).toHaveBeenCalledOnce()
  })

  it('shows the stop strip, naming the freeze, when saving also stopped', async () => {
    const room = frozenRoom()
    room.status = { ...room.status, saveState: 'failed', unsentCount: 1 }
    const root = await openedSurface()

    await vi.waitFor(() =>
      expect(stripTexts(root)).toEqual([
        "Saving stopped in this tab. Part of this document can't be shown here, so editing stays paused. Reload to try saving again.",
      ]),
    )
    expect(buttonLabelled(root, 'Reload')).toBeDefined()
  })

  it("freezes the real collab editor over text it can't show", async () => {
    realEditors.isOn = true
    const room = frozenRoom()
    const presence = { awareness: new Awareness(room.doc), peers: [], onChange: () => () => {} }
    Object.assign(room, { presence })
    room.status = { ...room.status, restoreRev: 0 }
    const root = await openedSurface()

    await vi.waitFor(() => expect(stripTexts(root)).toEqual([FROZEN]))
  })

  it("freezes the real old editor over text it can't show", async () => {
    realEditors.isOn = true
    stored.collab = 1
    const body = new Doc()
    body.getXmlFragment('default').insert(0, [unknownBlock()])
    stored.content = fromUint8Array(encodeStateAsUpdate(body))
    const root = await openedSurface()

    await vi.waitFor(() => expect(stripTexts(root)).toEqual([FROZEN]))
  })

  it('shows the freeze strip over the polling notice', async () => {
    const room = frozenRoom()
    room.status = { ...room.status, liveState: 'polling' }
    const root = await openedSurface()

    await vi.waitFor(() => expect(stripTexts(root)).toEqual([FROZEN]))
  })

  it('shows only the version bar while a version is previewed over a freeze', async () => {
    frozenRoom()
    const root = await openedSurface(oneVersion)
    await vi.waitFor(() => expect(stripTexts(root)).toEqual([FROZEN]))

    let during: string[] = []
    await previewAndReturn(root, () => {
      during = stripTexts(root)
    })

    expect([during, stripTexts(root)]).toEqual([['Viewing Before review'], [FROZEN]])
  })

  it('neither reports a frozen tab nor stops its room', async () => {
    const room = Object.assign(frozenRoom(), {
      stopForGood: vi.fn(async () => {}),
      suspect: { mark: vi.fn(), isJudging: false },
    })
    const root = await openedSurface()
    await vi.waitFor(() => expect(stripTexts(root)).toEqual([FROZEN]))
    await settled()

    expect([room.stopForGood.mock.calls, room.suspect.mark.mock.calls]).toEqual([[], []])
  })

  it('shows the freeze strip over the old editor, and its refused save over the freeze', async () => {
    oldEditor.isFrozen = true
    stored.collab = 1
    const frozen = await openedSurface()
    await vi.waitFor(() => expect(stripTexts(frozen)).toEqual([FROZEN]))
    document.body.innerHTML = ''

    stored.isRefusingSaves = true
    const refused = await openedSurface()

    await vi.waitFor(() => expect(stripTexts(refused)).toEqual([REFUSED_KEPT]))
    await discardCopies()
  })
})
