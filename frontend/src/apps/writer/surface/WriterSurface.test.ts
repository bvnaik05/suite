import { afterEach, describe, expect, it, vi } from 'vitest'

import { openedSurface, resetSurface, serverMinBuilds } from './writer-surface-fixtures'

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

async function openedEditor() {
  const root = await openedSurface()
  return root.querySelector('[data-editor]')!
}

describe('Writer surface', () => {
  it('edits a document while the tab meets the minimum Writer build', async () => {
    await serverMinBuilds({ writer: '100' })

    const editor = await openedEditor()

    expect(editor.getAttribute('data-editable')).toBe('true')
  })

  it('opens a document read-only in a tab older than the minimum Writer build', async () => {
    await serverMinBuilds({ writer: '150' })

    const editor = await openedEditor()

    expect(editor.getAttribute('data-editable')).toBe('false')
  })
})
