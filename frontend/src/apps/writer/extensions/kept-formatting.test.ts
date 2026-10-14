import { Editor, getSchema } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import type { UnplaceableReason } from '@tiptap/y-tiptap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import * as Y from 'yjs'

import { BODY_FIELD } from '../collab/field'
import { writerEditorExtensions } from '../editor-extensions'
import { writerSchema } from '../schema'

vi.mock('@/apps/writer/utils', () => ({ insertTemplate: () => {} }))
vi.mock('@/apps/writer/resources', () => ({ getTemplates: {} }))

interface Tab {
  ydoc: Y.Doc
  editor: Editor
  freezes: UnplaceableReason[]
}

type Attributes = Record<string, unknown>

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

const MYSTERY = { mystery: { shade: 'teal' } }

function text(...runs: [string, Attributes?][]) {
  const node = new Y.XmlText()
  node.applyDelta(runs.map(([insert, attributes]) => ({ insert, attributes })))
  return node
}

function block(name: string, ...runs: [string, Attributes?][]) {
  const node = new Y.XmlElement(name)
  node.insert(0, [text(...runs)])
  return node
}

function stored(node: Y.XmlElement) {
  const doc = new Y.Doc()
  doc.getXmlFragment(BODY_FIELD).insert(0, [node])
  return Y.encodeStateAsUpdate(doc)
}

function open(state: Uint8Array): Tab {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state, 'remote')
  const extensions = writerEditorExtensions({
    collaborative: true,
    mentionItems: () => [],
    onMentionQuery: () => {},
    onCommentActivated: () => {},
    onAnchors: () => {},
    scrollParent: () => window,
    media: null,
    comments: ydoc.getMap('comments'),
    ydoc,
    activeComment: ref(null),
    showComments: ref(false),
    showResolved: ref(false),
    edited: ref(false),
    onCommentsPainted: () => {},
  })
  const freezes: UnplaceableReason[] = []
  const ySyncOptions = { onUnplaceable: (reason: UnplaceableReason) => freezes.push(reason) }
  const collaboration = Collaboration.configure({ document: ydoc, field: BODY_FIELD, ySyncOptions })
  const mount = document.createElement('div')
  document.body.append(mount)
  const editor = new Editor({ element: mount, extensions: [...extensions, collaboration] })
  editors.push(editor)
  return { ydoc, editor, freezes }
}

// The first block's text runs as Yjs holds them
function storedRuns(tab: Tab) {
  const first = tab.ydoc.getXmlFragment(BODY_FIELD).get(0) as Y.XmlElement
  return (first.get(0) as Y.XmlText).toDelta()
}

function typeAtEnd(tab: Tab, typed: string) {
  const end = tab.editor.state.doc.firstChild!.nodeSize - 1
  tab.editor.view.dispatch(tab.editor.state.tr.insertText(typed, end))
}

describe('formatting the editor cannot show where it sits', () => {
  it('keeps an unknown mark on code text through an edit', () => {
    const tab = open(stored(block('paragraph', ['abc', { code: {}, ...MYSTERY }])))

    typeAtEnd(tab, 'Z')

    expect(tab.freezes).toEqual([])
    const [first] = storedRuns(tab)
    expect(first).toEqual({ insert: 'abc', attributes: { code: {}, ...MYSTERY } })
  })

  it('keeps bold on code text through an edit', () => {
    const tab = open(stored(block('paragraph', ['abc', { code: {}, bold: {} }])))

    typeAtEnd(tab, 'Z')

    expect(tab.freezes).toEqual([])
    const [first] = storedRuns(tab)
    expect(first).toEqual({ insert: 'abc', attributes: { code: {}, bold: {} } })
  })

  it('keeps bold in a code block through an edit', () => {
    const tab = open(stored(block('codeBlock', ['abc', { bold: {} }])))

    typeAtEnd(tab, 'Z')

    expect(tab.freezes).toEqual([])
    expect(storedRuns(tab)).toEqual([{ insert: 'abc', attributes: { bold: {} } }, { insert: 'Z' }])
  })

  it('keeps hidden keys when the text is made into code', () => {
    const tab = open(stored(block('paragraph', ['abc', MYSTERY])))

    tab.editor.chain().setTextSelection({ from: 1, to: 4 }).setMark('code').run()

    expect(storedRuns(tab)).toEqual([{ insert: 'abc', attributes: { code: {}, ...MYSTERY } }])
  })

  // Yjs ends the run with a null marker so the typed character doesn't take its keys
  it('writes only the typed character and the end of the run next to a kept run', () => {
    const tab = open(stored(block('paragraph', ['abc', MYSTERY])))
    const updates: Uint8Array[] = []
    tab.ydoc.on('update', (update: Uint8Array) => updates.push(update))

    typeAtEnd(tab, 'Z')

    const written = updates.flatMap((update) => Y.decodeUpdate(update).structs as Y.Item[])
    const strings = written.filter((item) => item.content instanceof Y.ContentString)
    const formats = written.filter((item) => item.content instanceof Y.ContentFormat)
    expect(strings.map((item) => (item.content as Y.ContentString).str)).toEqual(['Z'])
    expect(formats.map((item) => (item.content as Y.ContentFormat).value)).toEqual([null])
    expect(storedRuns(tab)).toEqual([{ insert: 'abc', attributes: MYSTERY }, { insert: 'Z' }])
  })

  it('writes nothing to a kept run when the block before it is deleted', () => {
    const doc = new Y.Doc()
    const body = doc.getXmlFragment(BODY_FIELD)
    body.insert(0, [block('paragraph', ['x']), block('paragraph', ['abc', MYSTERY])])
    const tab = open(Y.encodeStateAsUpdate(doc))
    const updates: Uint8Array[] = []
    tab.ydoc.on('update', (update: Uint8Array) => updates.push(update))

    tab.editor.view.dispatch(tab.editor.state.tr.delete(0, 3))

    expect(updates.flatMap((update) => Y.decodeUpdate(update).structs)).toEqual([])
    expect(storedRuns(tab)).toEqual([{ insert: 'abc', attributes: MYSTERY }])
  })

  it('drops kept keys when formatting is cleared', () => {
    const tab = open(stored(block('paragraph', ['abc', { bold: {}, ...MYSTERY }])))

    tab.editor.chain().setTextSelection({ from: 1, to: 4 }).unsetAllMarks().run()

    expect(storedRuns(tab)).toEqual([{ insert: 'abc' }])
  })
})

describe('kept formatting from anywhere but Yjs', () => {
  const planted = {
    type: 'text',
    text: 'xy',
    marks: [
      { type: 'keptFormatting', attrs: { attributes: { link: { href: 'https://x.test' } } } },
    ],
  }

  it('is dropped when inserted as content', () => {
    const tab = open(stored(block('paragraph', ['abc'])))

    tab.editor.commands.insertContentAt(4, planted)

    expect(storedRuns(tab)).toEqual([{ insert: 'abcxy' }])
  })

  it('is dropped when set as the content', () => {
    const tab = open(stored(block('paragraph', ['abc'])))

    tab.editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [planted] }],
    })

    expect(storedRuns(tab)).toEqual([{ insert: 'xy' }])
  })

  it('is dropped when set as a mark', () => {
    const tab = open(stored(block('paragraph', ['abc'])))

    tab.editor
      .chain()
      .setTextSelection({ from: 1, to: 4 })
      .setMark('keptFormatting', { attributes: { link: { href: 'https://x.test' } } })
      .run()

    expect(storedRuns(tab)).toEqual([{ insert: 'abc' }])
  })

  it('stays on text moved within the document', () => {
    const tab = open(stored(block('paragraph', ['abc', MYSTERY], ['de'])))
    const { state } = tab.editor
    const moved = state.doc.slice(1, 4)

    tab.editor.view.dispatch(state.tr.delete(1, 4).insert(3, moved.content))

    expect(storedRuns(tab)).toEqual([{ insert: 'de' }, { insert: 'abc', attributes: MYSTERY }])
  })
})

describe('the code mark', () => {
  it('excludes every Writer mark but kept formatting', () => {
    const schema = getSchema(writerSchema())
    const code = schema.marks.code
    const others = Object.values(schema.marks).filter((mark) => mark.name !== 'keptFormatting')

    expect(others.filter((mark) => !code.excludes(mark))).toEqual([])
    expect(code.excludes(schema.marks.keptFormatting)).toBe(false)
  })
})
