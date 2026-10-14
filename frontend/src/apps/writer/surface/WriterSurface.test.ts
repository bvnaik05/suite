import type { Editor as TiptapEditor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import * as Y from 'yjs'

import type { DocumentSession } from '@/apps/drive'

type Versions = DocumentSession['versions']

// The editor element's tiptap editor, as tiptap hangs it on the element
type EditorElement = HTMLElement & { editor: TiptapEditor }

vi.hoisted(() => {
  vi.stubGlobal('__SUITE_BUILD__', '100')
  vi.stubEnv('DEV', false)
})

vi.mock('frappe-ui', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  const emptyComponent = { render: () => null }
  return {
    Avatar: emptyComponent,
    Badge: emptyComponent,
    Dropdown: define({
      props: { options: Array as () => { label: string; onClick: () => void }[] },
      setup: (props) => () =>
        render(
          'div',
          { 'data-menu': '' },
          props.options?.map((option) =>
            render('button', { onClick: option.onClick }, option.label),
          ),
        ),
    }),
    Button: define({
      props: { label: String },
      emits: ['click'],
      setup:
        (props, { emit }) =>
        () =>
          render('button', { onClick: () => emit('click') }, props.label),
    }),
    Skeleton: emptyComponent,
    TextInput: emptyComponent,
    dialog: { confirm: (options: { onConfirm: () => void }) => options.onConfirm() },
    toast: {
      info: () => {},
      success: () => {},
      warning: () => {},
      error: () => {},
    },
  }
})

vi.mock('@/apps/drive', async () => {
  const { defineComponent: define, h: render, ref: state } = await import('vue')
  return {
    DriveDocumentHeader: define({
      emits: ['update:panel'],
      setup: (_, { emit }) => {
        const openVersions = {
          'data-open-versions': '',
          onClick: () => emit('update:panel', 'versions'),
        }
        return () => render('button', openVersions)
      },
    }),
    DriveCommentAuthor: define({ setup: () => () => null }),
    formatDriveDateTime: (await import('@/apps/drive/files/internal/format')).formatDate,
    GUEST_NAME_LIMIT: 140,
    useDriveGuestName: () => ({
      shown: state(false),
      text: state(''),
      atLimit: state(false),
      maxLength: 140,
      take: () => '',
    }),
  }
})

const rooms = vi.hoisted(() => ({ next: null as object | null }))
// The body the server holds for a document edited without collaboration
const stored = vi.hoisted(() => ({ html: '', collab: 0, isRefusingSaves: false }))
// The old editor's hold on its device store, which it gives up once a refused save is kept
const oldEditor = vi.hoisted(() => ({ forgetStoredEdits: vi.fn(async () => {}) }))

vi.mock('@/apps/writer/collab', () => ({
  BODY_FIELD: 'default',
  openWriterRoom: async () => (rooms.next ? { state: 'live', room: rooms.next } : { state: 'off' }),
  writerDeviceStore: async () => null,
}))

vi.mock('@/apps/writer/components/NonCollabEditor.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      props: { editable: Boolean, document: Object },
      setup: (props, { slots }) => {
        // Like the editor, the body is read once when it mounts
        const body = (props.document as { doc: { html: string } }).doc.html
        return () => {
          const toolbar = slots.toolbar?.()
          const editorBox = {
            'data-editor': '',
            'data-editable': props.editable,
            style: slots.cover && { display: 'none' },
          }
          return [toolbar, render('div', editorBox, body), slots.cover?.(), slots.aside?.()]
        }
      },
    }),
  }
})

vi.mock('./writerDocument', async (importOriginal) => {
  const original = await importOriginal<typeof import('./writerDocument')>()
  const idleWrite = () => ({
    loading: false,
    error: null,
    submit: async () => null,
    run: async () => {
      if (stored.isRefusingSaves) {
        throw Object.assign(new Error('CONFLICT'), { type: 'LoggedDocumentConflict' })
      }

      return null
    },
  })
  const writerDocument = () => {
    function read() {
      return { name: 'content-1', collab: stored.collab, settings: {}, html: stored.html }
    }

    const resources = reactive({
      doc: read(),
      saveDoc: idleWrite(),
      saveHtml: idleWrite(),
      saveComments: idleWrite(),
      reload: async () => {
        resources.doc = read()
      },
    })
    return resources
  }

  return {
    ...original,
    createWriterDocument: writerDocument,
  }
})

vi.mock('@/apps/writer/components/CollabTextEditor.vue', async () => {
  const { defineComponent: define, h: render, onBeforeUnmount, shallowRef } = await import('vue')
  const { Editor, EditorContent } = await import('@tiptap/vue-3')
  const { default: Document } = await import('@tiptap/extension-document')
  const { default: Paragraph } = await import('@tiptap/extension-paragraph')
  const { default: Text } = await import('@tiptap/extension-text')
  const { default: Collaboration } = await import('@tiptap/extension-collaboration')
  return {
    default: define({
      props: { room: Object },
      setup(props, { expose, slots }) {
        const room = props.room as { doc: Y.Doc }
        const collaboration = Collaboration.configure({ document: room.doc })
        const extensions = [Document, Paragraph, Text, collaboration]
        const editor = shallowRef(new Editor({ extensions }))
        expose({ editor })
        onBeforeUnmount(() => editor.value.destroy())

        return () => {
          const toolbar = slots.toolbar?.()
          const editorBox = {
            'data-editor': '',
            style: slots.cover && { display: 'none' },
          }
          const content = render(EditorContent, { editor: editor.value })
          return [toolbar, render('div', editorBox, [content]), slots.cover?.(), slots.aside?.()]
        }
      },
    }),
  }
})
vi.mock('@/apps/writer/components/TextEditor.vue', async () => {
  const { defineComponent: define, h: render, onMounted } = await import('vue')
  return {
    default: define({
      props: { document: Object },
      setup(props, { expose }) {
        const editor = { getHTML: () => '<p>Old editor line</p>', setEditable: () => {} }
        expose({ editor, forgetStoredEdits: oldEditor.forgetStoredEdits })
        // Its first autosave, which the server refuses for a logged document
        onMounted(() => {
          const document = props.document as {
            saveDoc: { run: (input: object) => Promise<unknown> }
          }
          void document.saveDoc.run({}).catch(() => {})
        })
        return () => render('div', { 'data-editor': '' })
      },
    }),
  }
})
vi.mock('@/apps/writer/components/UsersBar.vue', () => ({ default: { render: () => null } }))
vi.mock('./WriterDocumentMenu.vue', () => ({ default: { render: () => null } }))
vi.mock('./VersionPreview.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      props: { seq: Number },
      setup: (props, { expose }) => {
        expose({ isShown: true, versionHTML: () => '' })
        return () => render('div', { 'data-preview': props.seq })
      },
    }),
  }
})

const { default: WriterSurface } = await import('./WriterSurface.vue')
const { watchBuild } = await import('@/platform/build')
const { discardCopy, keepPageCopy, listCopies } = await import('@/apps/writer/recovery/copies')

async function serverMinBuilds(minBuilds: Record<string, string>, body = '{}') {
  const headers = { 'X-Suite-Min-Builds': JSON.stringify(minBuilds) }
  async function respond() {
    return new Response(body, { headers })
  }

  vi.stubGlobal('fetch', vi.fn(respond))
  watchBuild()
  await window.fetch('/api/method/ping')
}

async function openedSurface(versions?: Versions, path = '/d/node-1') {
  const session = {
    nodeId: 'node-1',
    title: ref('Quarterly plan'),
    state: ref('Active'),
    access: ref({ role: 50 }),
    refreshAccess: async () => {},
    versions,
    credentials: {
      context: {},
      heldContext: {},
      fetch,
      fetchHeld: fetch,
      group: () => [],
    },
  } as unknown as DocumentSession
  const surface = { render: () => h(WriterSurface, { session }) }
  const routes = [{ path: '/d/:node', component: surface }]
  const history = createMemoryHistory()
  const router = createRouter({ history, routes })
  await router.push(path)
  await router.isReady()

  const root = document.createElement('div')
  document.body.append(root)
  const shell = defineComponent({ setup: () => () => h(RouterView) })
  createApp(shell).use(router).mount(root)
  await vi.waitFor(() => expect(root.querySelector('[data-editor]')).not.toBeNull())
  await nextTick()
  return root
}

async function openedEditor() {
  const root = await openedSurface()
  return root.querySelector('[data-editor]')!
}

function buttonLabelled(root: Element, label: string) {
  return [...root.querySelectorAll('button')].find((button) => button.textContent === label)
}

// The row in the versions list whose text starts with `label`
function versionRow(root: Element, label: string) {
  const rows = [...root.querySelectorAll<HTMLElement>('aside button')]
  return rows.find((button) => button.textContent?.startsWith(label))!
}

afterEach(() => {
  document.body.innerHTML = ''
  rooms.next = null
  stored.html = ''
  stored.collab = 0
  stored.isRefusingSaves = false
  oldEditor.forgetStoredEdits.mockClear()
  vi.restoreAllMocks()
})

function liveRoom() {
  const room = {
    doc: new Y.Doc(),
    canWrite: true,
    blocked: null,
    paused: null,
    saveState: 'clean',
    unsent: 0,
    onDevice: true,
    onChange: () => () => {},
    flush: async () => {},
    close: vi.fn(async () => {}),
  }
  rooms.next = room
  return room
}

async function previewAndReturn(root: Element, during: () => void | Promise<void> = () => {}) {
  root.querySelector<HTMLElement>('[data-open-versions]')!.click()
  await vi.waitFor(() => expect(root.textContent).toContain('Before review'))
  versionRow(root, 'Before review').click()
  await nextTick()
  expect(root.querySelector('[data-preview]')).not.toBeNull()
  await during()
  buttonLabelled(root, 'Back to current')!.click()
  await nextTick()
}

const oneVersion = {
  list: async () => ({
    rows: [{ seq: 3, kind: 'named', label: 'Before review' }],
    next_cursor: null,
  }),
} as unknown as Versions

function statusWith(root: Element, text: string) {
  const statuses = [...root.querySelectorAll<HTMLElement>('[role="status"]')]
  return statuses.find((status) => status.textContent?.includes(text))
}

// A strip's classes without its colours
function shapeOf(strip: Element) {
  const colours = /^(bg-surface-|text-ink-|border-outline-)/
  return [...strip.classList].filter((name) => !colours.test(name)).sort()
}

function recoveryBanner(root: Element) {
  const statuses = [...root.querySelectorAll<HTMLElement>('[role="status"]')]
  return statuses.find((status) => status.textContent?.includes('This device has unsaved work'))
}

const STOPPED = 'Saving stopped in this tab. Reload to keep editing.'
const REFUSED =
  'This document now saves as you edit, so saving stopped in this tab. Reload to keep editing.'
const REFUSED_KEPT =
  'This document now saves as you edit, so saving stopped in this tab. Unsent changes were kept as a recovery copy. Reload to keep editing.'

// A live room whose saving failed for good, which the page shows as the stop strip
function stoppedRoom() {
  const room = liveRoom()
  room.saveState = 'failed'
  room.unsent = 1
  return room
}

// Each shown strip's message, without its buttons
function stripTexts(root: Element) {
  const strips = [...root.querySelectorAll('[role="status"]')]
  return strips.map((strip) => strip.querySelector('p')?.textContent?.trim() ?? '')
}

// Lets the recovery strip finish reading the device's copies
async function settled() {
  await new Promise((resolve) => setTimeout(resolve, 50))
  await nextTick()
}

async function discardCopies() {
  for (const copy of await listCopies('node-1')) {
    await discardCopy(copy)
  }
}

const shownText = (root: Element) => root.querySelector('[data-editor] .ProseMirror')!.textContent

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

  it('shows who took a version and its exact date and time', async () => {
    vi.stubEnv('TZ', 'UTC')
    const list = async () => ({
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
    })
    const root = await openedSurface({ list } as unknown as Versions)

    root.querySelector<HTMLElement>('[data-open-versions]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Before review'))
    const row = versionRow(root, 'Before review')
    expect(row.textContent).toMatch(
      /ana@example\.com · (Mar 4, 2025|4 Mar 2025), 10:41(\s(AM|am))?$/,
    )
    expect(row.textContent).not.toContain('2025-03-04T10:41:00Z')
    vi.unstubAllEnvs()
  })

  it('shows a version in place of the editor until Back to current', async () => {
    const list = vi.fn(async () => ({
      rows: [{ seq: 3, kind: 'named', label: 'Before review' }],
      next_cursor: null,
    }))
    const root = await openedSurface({ list } as unknown as Versions)
    const editorShown = () =>
      root.querySelector<HTMLElement>('[data-editor]')!.style.display !== 'none'

    root.querySelector<HTMLElement>('[data-open-versions]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Before review'))
    versionRow(root, 'Before review').click()
    await nextTick()

    const preview = root.querySelector<HTMLElement>('[data-preview]')!
    expect(preview.getAttribute('data-preview')).toBe('3')
    expect(editorShown()).toBe(false)

    buttonLabelled(root, 'Back to current')!.click()
    await nextTick()
    expect(root.querySelector('[data-preview]')).toBeNull()
    expect(editorShown()).toBe(true)
    expect(document.activeElement?.textContent).toMatch(/^Before review/)
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
    buttonLabelled(root, 'Restore')!.click()

    await vi.waitFor(() => expect(editor().textContent).toBe('<p>Back then</p>'))
    expect(restore).toHaveBeenCalledWith('3')
    expect(root.querySelector('[data-preview]')).toBeNull()
  })

  it('shows edits made in another tab while a version was previewed', async () => {
    const room = liveRoom()
    const root = await openedSurface(oneVersion)
    const otherTab = new Y.Doc()
    Y.applyUpdate(otherTab, Y.encodeStateAsUpdate(room.doc))

    const typeInOtherTab = () => {
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.insert(0, [new Y.XmlText('Typed in the other tab')])
      otherTab.getXmlFragment('default').insert(0, [paragraph])
      const roomVector = Y.encodeStateVector(room.doc)
      const missing = Y.encodeStateAsUpdate(otherTab, roomVector)
      Y.applyUpdate(room.doc, missing)
    }
    await previewAndReturn(root, typeInOtherTab)

    expect(shownText(root)).toContain('Typed in the other tab')
    expect(room.close).not.toHaveBeenCalled()
  })

  it('keeps text typed just before a preview, undoable and on its way to other tabs', async () => {
    const room = liveRoom()
    const root = await openedSurface(oneVersion)
    const editor = () => root.querySelector<EditorElement>('[data-editor] .ProseMirror')!.editor

    editor().commands.insertContent('Typed here first')
    await previewAndReturn(root)

    expect(shownText(root)).toContain('Typed here first')
    const otherTab = new Y.Doc()
    Y.applyUpdate(otherTab, Y.encodeStateAsUpdate(room.doc))
    expect(otherTab.getXmlFragment('default').toString()).toContain('Typed here first')
    editor().commands.undo()
    expect(shownText(root)).not.toContain('Typed here first')
  })

  it('hides the recovery banner while a copy is shown, and brings it back after', async () => {
    keepPageCopy('node-1', 'Quarterly plan', '<p>Typed while offline</p>')
    const [copy] = await listCopies('node-1')
    const root = await openedSurface()
    await vi.waitFor(() => expect(recoveryBanner(root)).toBeDefined())

    buttonLabelled(recoveryBanner(root)!, 'View')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Viewing recovery copy from'))
    expect(recoveryBanner(root)).toBeUndefined()

    buttonLabelled(root, 'Back to current')!.click()
    await vi.waitFor(() => expect(recoveryBanner(root)).toBeDefined())
    await discardCopy(copy)
  })

  it('keeps Back to current in the recovery bar’s menu, first, and the version bar’s as a button', async () => {
    keepPageCopy('node-1', 'Quarterly plan', '<p>Typed while offline</p>')
    const [copy] = await listCopies('node-1')
    const root = await openedSurface(oneVersion)
    await vi.waitFor(() => expect(recoveryBanner(root)).toBeDefined())

    buttonLabelled(recoveryBanner(root)!, 'View')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Viewing recovery copy from'))
    const bar = [...root.querySelectorAll('[role="status"]')].find((status) =>
      status.textContent?.includes('Viewing recovery copy from'),
    )!
    const menu = [...bar.querySelectorAll('[data-menu] button')].map((item) => item.textContent)
    const buttons = [...bar.querySelectorAll('button')].map((item) => item.textContent)
    expect([menu, buttons]).toEqual([
      ['Back to current', 'Copy', 'Download', 'Discard'],
      ['Back to current', 'Copy', 'Download', 'Discard'],
    ])

    buttonLabelled(bar, 'Back to current')!.click()
    await vi.waitFor(() => expect(root.textContent).not.toContain('Viewing recovery copy from'))
    await previewAndReturn(root)
    await discardCopy(copy)
  })

  it('draws the recovery banner, the recovery bar and the version bar alike but for colour', async () => {
    keepPageCopy('node-1', 'Quarterly plan', '<p>Typed while offline</p>')
    const [copy] = await listCopies('node-1')
    const root = await openedSurface(oneVersion)
    await vi.waitFor(() => expect(recoveryBanner(root)).toBeDefined())
    const banner = recoveryBanner(root)!
    buttonLabelled(banner, 'View')!.click()
    await vi.waitFor(() => expect(statusWith(root, 'Viewing recovery copy from')).toBeDefined())
    const copyBar = statusWith(root, 'Viewing recovery copy from')!
    const copyShape = shapeOf(copyBar)
    buttonLabelled(copyBar, 'Back to current')!.click()
    await nextTick()

    let versionShape: string[] = []
    await previewAndReturn(root, () => {
      versionShape = shapeOf(statusWith(root, 'Viewing Before review')!)
    })

    expect([shapeOf(banner), copyShape]).toEqual([versionShape, versionShape])
    expect(banner.querySelector('[class*="lucide-"]')).toBeNull()
    await discardCopy(copy)
  })

  it('shows the stop strip alone when this device also holds a recovery copy', async () => {
    stoppedRoom()
    keepPageCopy('node-1', 'Quarterly plan', '<p>Typed while offline</p>')
    const root = await openedSurface()

    await vi.waitFor(() => expect(statusWith(root, STOPPED)).toBeDefined())
    await settled()
    expect(stripTexts(root)).toEqual([STOPPED])
    await discardCopies()
  })

  it('shows only the version bar while a version is previewed over a stop and a recovery copy', async () => {
    stoppedRoom()
    keepPageCopy('node-1', 'Quarterly plan', '<p>Typed while offline</p>')
    const root = await openedSurface(oneVersion)
    await vi.waitFor(() => expect(statusWith(root, STOPPED)).toBeDefined())

    let during: string[] = []
    await previewAndReturn(root, () => {
      during = stripTexts(root)
    })

    expect([during, stripTexts(root)]).toEqual([['Viewing Before review'], [STOPPED]])
    await discardCopies()
  })

  it('shows the stop strip on Back to current when the stop came during a preview', async () => {
    const room = liveRoom()
    const changes: (() => void)[] = []
    room.onChange = (listener: () => void) => {
      changes.push(listener)
      return () => {}
    }

    const root = await openedSurface(oneVersion)

    let during: string[] = []
    await previewAndReturn(root, async () => {
      Object.assign(room, { saveState: 'failed', unsent: 1 })
      for (const change of changes) {
        change()
      }

      await nextTick()
      during = stripTexts(root)
    })

    expect([during, stripTexts(root)]).toEqual([['Viewing Before review'], [STOPPED]])
  })

  it('shows only the recovery bar while a copy is viewed over a stop', async () => {
    stoppedRoom()
    keepPageCopy('node-1', 'Quarterly plan', '<p>Typed while offline</p>')
    const [copy] = await listCopies('node-1')
    const key = encodeURIComponent(copy.key)
    const root = await openedSurface(undefined, `/d/node-1?recovery=${key}`)

    await vi.waitFor(() => expect(statusWith(root, 'Viewing recovery copy from')).toBeDefined())
    await settled()
    expect(stripTexts(root)).toHaveLength(1)
    await discardCopies()
  })

  it("clears the old editor's store once its refused save is kept as a recovery copy", async () => {
    Object.assign(stored, { collab: 1, isRefusingSaves: true })
    const root = await openedSurface()

    await vi.waitFor(() => expect(oldEditor.forgetStoredEdits).toHaveBeenCalledOnce())
    expect((await listCopies('node-1')).map((copy) => copy.html)).toEqual([
      '<p>Old editor line</p>',
    ])
    expect(stripTexts(root)).toEqual([REFUSED_KEPT])
    await discardCopies()
  })

  it("keeps the old editor's store when the recovery copy can't be kept", async () => {
    Object.assign(stored, { collab: 1, isRefusingSaves: true })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    const root = await openedSurface()

    await vi.waitFor(() => expect(stripTexts(root)).toEqual([REFUSED]))
    await settled()
    expect(oldEditor.forgetStoredEdits).not.toHaveBeenCalled()
  })

  it('opens the recovery copy a link names, in place of the editor', async () => {
    keepPageCopy('node-1', 'Quarterly plan', '<p>Typed while offline</p>')
    const [copy] = await listCopies('node-1')
    const key = encodeURIComponent(copy.key)
    const root = await openedSurface(undefined, `/d/node-1?recovery=${key}`)

    await vi.waitFor(() => expect(root.textContent).toContain('Viewing recovery copy from'))
    expect(root.querySelector('[aria-label="Recovery copy"]')!.textContent).toBe(
      'Typed while offline',
    )
    await discardCopy(copy)
  })
})
