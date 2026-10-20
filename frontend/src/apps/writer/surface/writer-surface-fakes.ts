import { vi } from 'vitest'
import { reactive } from 'vue'
import type { Doc } from 'yjs'

export const rooms = { next: null as object | null }
// The body the server holds for a document edited without collaboration
export const stored = { html: '', content: '', collab: 0, isRefusingSaves: false }
// The old editor's hold on its device store, which it gives up once a refused save is kept
export const oldEditor = { forgetStoredEdits: vi.fn(async () => {}), isFrozen: false }
// Mounts the real editors, over a stand-in for CoreEditor, in place of the fakes below
export const realEditors = { isOn: false }

export async function fakeFrappeUi() {
  const { defineComponent: define, h: render, ref: state } = await import('vue')
  const emptyComponent = { render: () => null }
  return {
    Avatar: emptyComponent,
    Badge: emptyComponent,
    // The real old editor's autosave runs at once
    debounce: (run: () => void) => run,
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
    Textarea: define({
      setup(_, { expose }) {
        const box = state<HTMLTextAreaElement | null>(null)
        expose({ focus: () => box.value?.focus() })
        return () => render('textarea', { ref: box })
      },
    }),
    TextInput: define({
      props: { modelValue: String },
      emits: ['update:modelValue'],
      setup(props, { emit, expose }) {
        const input = state<HTMLInputElement | null>(null)
        expose({ focus: () => input.value?.focus() })
        function write(event: Event) {
          emit('update:modelValue', (event.target as HTMLInputElement).value)
        }

        return () => render('input', { ref: input, value: props.modelValue, onInput: write })
      },
    }),
    Tooltip: define({
      setup:
        (_, { slots }) =>
        () =>
          slots.default?.(),
    }),
    dialog: { confirm: (options: { onConfirm: () => void }) => options.onConfirm() },
    toast: {
      info: () => {},
      success: () => {},
      warning: () => {},
      error: () => {},
    },
  }
}

export async function fakeDrive() {
  const { defineComponent: define, h: render, ref: state } = await import('vue')
  return {
    DriveDocumentHeader: define({
      emits: ['update:panel'],
      setup: (_, { emit, slots }) => {
        const openVersions = {
          'data-open-versions': '',
          onClick: () => emit('update:panel', 'versions'),
        }
        const openComments = {
          'data-open-comments': '',
          onClick: () => emit('update:panel', 'comments'),
        }
        return () => [
          render('button', openVersions),
          render('button', openComments),
          slots.actions?.(),
        ]
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
}

export async function fakeWebrtc() {
  const { Awareness: MockAwareness } = await import('y-protocols/awareness')
  class WebrtcProvider {
    awareness: InstanceType<typeof MockAwareness>
    room = null
    disconnect = vi.fn()
    destroy = vi.fn()

    constructor(_room: string, doc: Doc) {
      this.awareness = new MockAwareness(doc)
    }
  }

  return { WebrtcProvider }
}

export async function fakeCoreEditor() {
  const { defineComponent: define, h: render, onBeforeUnmount, shallowRef } = await import('vue')
  const { Editor, EditorContent } = await import('@tiptap/vue-3')
  const { default: Document } = await import('@tiptap/extension-document')
  const { default: Paragraph } = await import('@tiptap/extension-paragraph')
  const { default: Text } = await import('@tiptap/extension-text')
  return {
    default: define({
      props: { extensions: Array },
      setup(props, { expose, slots }) {
        const extensions = [Document, Paragraph, Text, ...(props.extensions as [])]
        const editor = shallowRef(new Editor({ extensions }))
        expose({ editor })
        onBeforeUnmount(() => editor.value.destroy())
        return () => [
          render('div', { 'data-editor': '', id: 'editor-scroll-container' }, [
            render(EditorContent, { editor: editor.value }),
          ]),
          slots.aside?.(),
        ]
      },
    }),
  }
}

export async function fakeCollabPlatform() {
  return {
    ...(await import('@suite/collab-client')),
    openCollabRoom: async () => {
      if (rooms.next) {
        return { state: 'live', room: rooms.next }
      }

      return { state: 'disabled' }
    },
    openSignedInDeviceStore: async () => null,
  }
}

export async function fakeNonCollabEditor() {
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
}

export function fakeWriterDocument(original: typeof import('./writerDocument')) {
  function idleWrite() {
    return {
      loading: false,
      error: null,
      submit: async () => null,
      run: async () => {
        if (stored.isRefusingSaves) {
          throw Object.assign(new Error('CONFLICT'), { type: 'LoggedDocumentConflict' })
        }

        return null
      },
    }
  }

  function writerDocument() {
    function read() {
      const { collab, html, content } = stored
      return { name: 'content-1', collab, settings: {}, html, content }
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
}

export async function fakeCollabTextEditor(
  real: typeof import('@/apps/writer/components/CollabTextEditor.vue'),
) {
  const {
    defineComponent: define,
    h: render,
    onBeforeUnmount,
    ref: mockRef,
    shallowRef,
  } = await import('vue')
  const { Editor, EditorContent } = await import('@tiptap/vue-3')
  const { default: Document } = await import('@tiptap/extension-document')
  const { default: Paragraph } = await import('@tiptap/extension-paragraph')
  const { default: Text } = await import('@tiptap/extension-text')
  const { default: Collaboration } = await import('@tiptap/extension-collaboration')
  const fake = define({
    props: { room: Object },
    setup(props, { expose, slots }) {
      const room = props.room as { doc: Doc }
      const isFrozen = mockRef(false)
      function onFrozen() {
        isFrozen.value = true
      }

      const ySyncOptions = { onUnplaceable: onFrozen }
      const collaboration = Collaboration.configure({ document: room.doc, ySyncOptions })
      const extensions = [Document, Paragraph, Text, collaboration]
      const editor = shallowRef(new Editor({ extensions }))
      expose({ editor, isFrozen })
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
  })
  // Read where the surface renders it, so each test picks the real editor or the fake
  return {
    get default() {
      if (realEditors.isOn) {
        return real.default
      }

      return fake
    },
  }
}

export async function fakeTextEditor(
  real: typeof import('@/apps/writer/components/TextEditor.vue'),
) {
  const { defineComponent: define, h: render, onMounted, ref: mockRef } = await import('vue')
  const fake = define({
    props: { document: Object },
    setup(props, { expose }) {
      const editor = { getHTML: () => '<p>Old editor line</p>', setEditable: () => {} }
      const isFrozen = mockRef(oldEditor.isFrozen)
      expose({ editor, forgetStoredEdits: oldEditor.forgetStoredEdits, isFrozen })
      // Its first autosave, which the server refuses for a logged document
      onMounted(() => {
        const document = props.document as {
          saveDoc: { run: (input: object) => Promise<unknown> }
        }
        void document.saveDoc.run({}).catch(() => {})
      })
      return () => render('div', { 'data-editor': '' })
    },
  })
  return {
    get default() {
      if (realEditors.isOn) {
        return real.default
      }

      return fake
    },
  }
}

export async function fakeDocumentMenu() {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      emits: ['saveVersion'],
      setup:
        (_, { emit }) =>
        () =>
          render('button', { 'data-save-version': '', onClick: () => emit('saveVersion') }),
    }),
  }
}

export function fakeUsers(original: typeof import('@/apps/writer/composables/useUsers')) {
  return {
    ...original,
    fullName: (user: string) => user,
  }
}

export async function fakeVersionPreview() {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      props: { seq: Number },
      setup: (props) => () => render('div', { 'data-preview': props.seq }),
    }),
  }
}
