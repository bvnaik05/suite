import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector, XmlElement, XmlText } from 'yjs'

import { stored } from './writer-surface-fakes'
import {
  buttonLabelled,
  liveRoom,
  oneVersion,
  openedSurface,
  previewAndReturn,
  resetSurface,
  serverMinBuilds,
  versionRow,
  type EditorElement,
  type Versions,
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

function shownText(root: Element) {
  return root.querySelector('[data-editor] .ProseMirror')!.textContent
}

describe('Writer surface', () => {
  it('shows the next page of versions after Load more', async () => {
    const pages: Record<string, unknown> = {
      first: {
        rows: [{ seq: 2, kind: 'named', label: 'Draft two' }],
        next_cursor: 'page-2',
      },
      'page-2': {
        rows: [{ seq: 1, kind: 'named', label: 'Draft one' }],
        next_cursor: null,
      },
    }
    const list = vi.fn(async (cursor?: string) => pages[cursor ?? 'first'])
    const root = await openedSurface({ list } as unknown as Versions)

    root.querySelector<HTMLElement>('[data-open-versions]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Draft two'))
    expect(root.textContent).not.toContain('Draft one')

    buttonLabelled(root, 'Load more')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Draft one'))
    expect(root.textContent).toContain('Draft two')
    expect(buttonLabelled(root, 'Load more')).toBeUndefined()
  })

  it('shows who took a version and when, under the day it was taken', async () => {
    vi.stubEnv('TZ', 'UTC')
    async function list() {
      return {
        rows: [
          {
            seq: 3,
            kind: 'named',
            label: 'Before review',
            actor: 'ana@example.com',
            creation: '2025-03-04T10:41:00Z',
          },
        ],
        next_cursor: null,
      }
    }

    const root = await openedSurface({ list } as unknown as Versions)

    root.querySelector<HTMLElement>('[data-open-versions]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Before review'))
    const row = versionRow(root, 'Before review')
    const day = row.closest('section')!.querySelector('h3')!
    expect(row.textContent).toMatch(/ana@example\.com · 10:41(\s(AM|am))?$/)
    expect(day.textContent).toMatch(/^(Mar 4, 2025|4 Mar 2025)$/)
    vi.unstubAllEnvs()
  })

  it('opens the Versions panel from Save version in the document menu, with the cursor in the name box', async () => {
    const root = await openedSurface(oneVersion)

    root.querySelector<HTMLElement>('[data-save-version]')!.click()
    await vi.waitFor(() =>
      expect(root.querySelector('input[aria-label="Version name"]')).not.toBeNull(),
    )

    expect(document.activeElement).toBe(root.querySelector('input[aria-label="Version name"]'))
    expect(root.querySelector('aside')?.textContent).toContain('Before review')
  })

  it('opens the Versions name box from Save version on Current version, with the cursor in it', async () => {
    const root = await openedSurface(oneVersion)

    root.querySelector<HTMLElement>('[data-open-versions]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Before review'))
    expect(root.querySelector('input[aria-label="Version name"]')).toBeNull()
    buttonLabelled(root.querySelector('aside')!, 'Save version')!.click()
    await vi.waitFor(() =>
      expect(root.querySelector('input[aria-label="Version name"]')).not.toBeNull(),
    )

    expect(document.activeElement).toBe(root.querySelector('input[aria-label="Version name"]'))
  })

  it('shows a version in place of the editor until Current version', async () => {
    const list = vi.fn(async () => ({
      rows: [{ seq: 3, kind: 'named', label: 'Before review' }],
      next_cursor: null,
    }))
    const root = await openedSurface({ list } as unknown as Versions)
    function editorShown() {
      return root.querySelector<HTMLElement>('[data-editor]')!.style.display !== 'none'
    }

    root.querySelector<HTMLElement>('[data-open-versions]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Before review'))
    versionRow(root, 'Before review').click()
    await nextTick()

    const preview = root.querySelector<HTMLElement>('[data-preview]')!
    expect(preview.getAttribute('data-preview')).toBe('3')
    expect(editorShown()).toBe(false)

    versionRow(root, 'Current version').click()
    await nextTick()
    expect(root.querySelector('[data-preview]')).toBeNull()
    expect(editorShown()).toBe(true)
  })

  it('restores a version of a document edited without collaboration and shows its text', async () => {
    // An earlier test unstubs every env, and the build floor is read only outside DEV
    vi.stubEnv('DEV', false)
    // Every request answers with the stored version, which shows no images
    await serverMinBuilds({ writer: '100' }, '<p>Back then</p>')
    stored.html = '<p>Today</p>'
    const restore = vi.fn(async () => {
      stored.html = '<p>Back then</p>'
    })
    const root = await openedSurface({
      ...oneVersion,
      contentUrl: () => '/version/3',
      restore,
    } as unknown as Versions)
    function editor() {
      return root.querySelector('[data-editor]')!
    }

    root.querySelector<HTMLElement>('[data-open-versions]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Before review'))
    versionRow(root, 'Before review').click()
    await nextTick()
    buttonLabelled(root.querySelector('aside')!, 'Restore this version')!.click()

    await vi.waitFor(() => expect(editor().textContent).toBe('<p>Back then</p>'))
    expect(restore).toHaveBeenCalledWith('3')
    expect(root.querySelector('[data-preview]')).toBeNull()
  })

  it('restores the shown version from the version bar, the same as from its row', async () => {
    vi.stubEnv('DEV', false)
    await serverMinBuilds({ writer: '100' }, '<p>Back then</p>')
    stored.html = '<p>Today</p>'
    const restore = vi.fn(async () => {
      stored.html = '<p>Back then</p>'
    })
    const root = await openedSurface({
      ...oneVersion,
      contentUrl: () => '/version/3',
      restore,
    } as unknown as Versions)

    root.querySelector<HTMLElement>('[data-open-versions]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Before review'))
    versionRow(root, 'Before review').click()
    await nextTick()
    const bar = [...root.querySelectorAll('[role="status"]')].find((status) =>
      status.textContent?.includes('Viewing Before review'),
    )!
    buttonLabelled(bar, 'Restore this version')!.click()

    await vi.waitFor(() =>
      expect(root.querySelector('[data-editor]')!.textContent).toBe('<p>Back then</p>'),
    )
    expect(restore).toHaveBeenCalledWith('3')
    expect(root.querySelector('[data-preview]')).toBeNull()
  })

  it('offers no Restore on the version bar to someone who can’t restore', async () => {
    const root = await openedSurface(oneVersion, '/d/node-1', undefined, ref({ role: 30 }))

    root.querySelector<HTMLElement>('[data-open-versions]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Before review'))
    versionRow(root, 'Before review').click()
    await nextTick()
    const bar = [...root.querySelectorAll('[role="status"]')].find((status) =>
      status.textContent?.includes('Viewing Before review'),
    )!
    expect(bar.querySelectorAll('button')).toHaveLength(0)
  })

  it('shows edits made in another tab while a version was previewed', async () => {
    const room = liveRoom()
    const root = await openedSurface(oneVersion)
    const otherTab = new Doc()
    applyUpdate(otherTab, encodeStateAsUpdate(room.doc))

    function typeInOtherTab() {
      const paragraph = new XmlElement('paragraph')
      paragraph.insert(0, [new XmlText('Typed in the other tab')])
      otherTab.getXmlFragment('default').insert(0, [paragraph])
      const roomVector = encodeStateVector(room.doc)
      const missing = encodeStateAsUpdate(otherTab, roomVector)
      applyUpdate(room.doc, missing)
    }

    await previewAndReturn(root, typeInOtherTab)

    expect(shownText(root)).toContain('Typed in the other tab')
    expect(room.close).not.toHaveBeenCalled()
  })

  it('keeps text typed just before a preview, undoable and on its way to other tabs', async () => {
    const room = liveRoom()
    const root = await openedSurface(oneVersion)
    function editor() {
      return root.querySelector<EditorElement>('[data-editor] .ProseMirror')!.editor
    }

    editor().commands.insertContent('Typed here first')
    await previewAndReturn(root)

    expect(shownText(root)).toContain('Typed here first')
    const otherTab = new Doc()
    applyUpdate(otherTab, encodeStateAsUpdate(room.doc))
    expect(otherTab.getXmlFragment('default').toString()).toContain('Typed here first')
    editor().commands.undo()
    expect(shownText(root)).not.toContain('Typed here first')
  })
})
