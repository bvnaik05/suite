import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { writerSchema } from '../schema'
import { anchorEnds, DOCUMENT_ANCHOR, encodeAnchor, readAnchor } from './anchors'
import { anchorSelection, placeThread } from './places'

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

function openEditor(doc = new Y.Doc()) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

// Writer's own schema, with the mention, tag and line break a quote has to read
function openWriterEditor(content: string) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...writerSchema(), Collaboration.configure({ document: new Y.Doc() })],
  })
  editors.push(editor)
  editor.commands.setContent(content)
  return editor
}

function quoteOf(editor: Editor, from: number, to: number) {
  editor.commands.setTextSelection({ from, to })
  const read = readAnchor(anchorSelection(editor.state)!)
  if (read.kind !== 'text') {
    return read.kind
  }

  return read.quote
}

function paragraphText(doc: Y.Doc, index = 0) {
  return (doc.getXmlFragment('default').get(index) as Y.XmlElement).get(0) as Y.XmlText
}

// A thread on characters [start, end) of a paragraph, made the way a tab makes one
function anchorOn(text: Y.XmlText, start: number, end: number) {
  const from = Y.createRelativePositionFromTypeIndex(text, start, 0)
  const to = Y.createRelativePositionFromTypeIndex(text, end, -1)
  return encodeAnchor(from, to, text.toString().slice(start, end))
}

function shownText(editor: Editor, anchor: string) {
  const place = placeThread(editor.state, anchor)
  if (place.kind !== 'text') {
    return place.kind
  }

  return editor.state.doc.textBetween(place.from, place.to)
}

describe('where a thread shows', () => {
  it('follows its words while text is typed before them and at both edges', () => {
    const doc = new Y.Doc()
    const editor = openEditor(doc)
    editor.commands.setContent('<p>hello world</p>')
    const anchor = anchorOn(paragraphText(doc), 6, 11)

    editor.commands.insertContentAt(1, 'well, ')
    editor.commands.insertContentAt(13, '[')
    editor.commands.insertContentAt(19, ']')

    expect([editor.getText(), shownText(editor, anchor)]).toEqual(['well, hello [world]', 'world'])
  })

  it('keeps what is left when its first or last character is deleted', () => {
    const doc = new Y.Doc()
    const editor = openEditor(doc)
    editor.commands.setContent('<p>hello world</p>')
    const anchor = anchorOn(paragraphText(doc), 6, 11)

    editor.commands.deleteRange({ from: 7, to: 8 })
    editor.commands.deleteRange({ from: 10, to: 11 })

    expect(shownText(editor, anchor)).toBe('orl')
  })

  it('is deleted, with its quote, once all its words are gone or their paragraph is', () => {
    const doc = new Y.Doc()
    const editor = openEditor(doc)
    editor.commands.setContent('<p>hello world</p><p>second line</p>')
    const onWorld = anchorOn(paragraphText(doc), 6, 11)
    const onSecond = anchorOn(paragraphText(doc, 1), 0, 6)

    editor.commands.deleteRange({ from: 7, to: 12 })
    editor.commands.deleteRange({ from: 8, to: 21 })

    expect(editor.getText()).toBe('hello ')
    expect(placeThread(editor.state, onWorld)).toEqual({ kind: 'deleted', quote: 'world' })
    expect(placeThread(editor.state, onSecond)).toEqual({ kind: 'deleted', quote: 'second' })
  })

  it("waits for another tab's text before showing a thread on it", () => {
    const local = new Y.Doc()
    const editor = openEditor(local)
    editor.commands.setContent('<p>hello</p>')
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local))
    const before = Y.encodeStateVector(remote)
    paragraphText(remote).insert(5, ' there')
    const anchor = anchorOn(paragraphText(remote), 6, 11)

    const waiting = placeThread(editor.state, anchor)
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, before))

    expect(waiting).toEqual({ kind: 'arriving', quote: 'there' })
    expect(shownText(editor, anchor)).toBe('there')
  })

  it('shows a document thread on the document and an old comment id as not attached', () => {
    const editor = openEditor()

    expect(placeThread(editor.state, DOCUMENT_ANCHOR)).toEqual({ kind: 'document' })
    expect(placeThread(editor.state, '5f0c2e6a-old-comment')).toEqual({ kind: 'unplaced' })
  })
})

// Each pair of client ids, local then remote, so either one can win yjs's ordering
const ORDERINGS = [
  [1, 2],
  [2, 1],
  [100, 7],
  [7, 100],
]

// A thread on "quick brown" made in a tab, and another tab's doc holding the same text
function threadWithRemote([localClient, remoteClient]: number[]) {
  const local = new Y.Doc()
  local.clientID = localClient
  const editor = openEditor(local)
  editor.commands.setContent('<p>The quick brown fox jumps</p>')
  editor.commands.setTextSelection({ from: 5, to: 16 })
  const anchor = anchorSelection(editor.state)!
  const remote = new Y.Doc()
  remote.clientID = remoteClient
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local))
  return { local, editor, anchor, remote }
}

function editRemotely(local: Y.Doc, remote: Y.Doc, edit: (doc: Y.Doc) => void) {
  const before = Y.encodeStateVector(local)
  edit(remote)
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, before))
}

function shownAfterRemoteEdit(ordering: number[], edit: (text: Y.XmlText) => void) {
  const { local, editor, anchor, remote } = threadWithRemote(ordering)
  editRemotely(local, remote, (doc) => edit(paragraphText(doc)))
  const place = placeThread(editor.state, anchor)
  if (place.kind !== 'text') {
    return place
  }

  return editor.state.doc.textBetween(place.from, place.to)
}

describe('where a thread shows after another tab edits its text', () => {
  const removed = { kind: 'deleted', quote: 'quick brown' }

  it.each([
    {
      name: 'retypes its first character',
      edit: (text: Y.XmlText) => {
        text.delete(4, 1)
        text.insert(4, 'Q')
      },
      shown: 'Quick brown',
    },
    {
      name: 'types inside it',
      edit: (text: Y.XmlText) => text.insert(9, ' very'),
      shown: 'quick very brown',
    },
    {
      name: 'deletes it with its neighbours',
      edit: (text: Y.XmlText) => text.delete(3, 13),
      shown: removed,
    },
    {
      name: 'deletes its last character',
      edit: (text: Y.XmlText) => text.delete(14, 1),
      shown: 'quick brow',
    },
    { name: 'deletes all of it', edit: (text: Y.XmlText) => text.delete(4, 11), shown: removed },
    {
      name: 'types right after it',
      edit: (text: Y.XmlText) => text.insert(15, '!!'),
      shown: 'quick brown',
    },
    {
      name: 'types right before it',
      edit: (text: Y.XmlText) => text.insert(4, '>>'),
      shown: 'quick brown',
    },
  ])('shows the same place in every client order when another tab $name', ({ edit, shown }) => {
    const places = ORDERINGS.map((ordering) => shownAfterRemoteEdit(ordering, edit))

    expect(places).toEqual(ORDERINGS.map(() => shown))
  })

  it('is deleted, with its quote, in a doc opened after its paragraph was deleted and collected', () => {
    const places = ORDERINGS.map((ordering) => {
      const { local, anchor, remote } = threadWithRemote(ordering)
      editRemotely(local, remote, (doc) => doc.getXmlFragment('default').delete(0, 1))
      const fresh = new Y.Doc()
      Y.applyUpdate(fresh, Y.encodeStateAsUpdate(local))
      return placeThread(openEditor(fresh).state, anchor)
    })

    expect(places).toEqual(ORDERINGS.map(() => removed))
  })
})

// A thread from "bb" to "cc", across two paragraphs, made in a tab
function threadAcrossParagraphs() {
  const local = new Y.Doc()
  const editor = openEditor(local)
  editor.commands.setContent('<p>aa bb</p><p>cc dd</p>')
  editor.commands.setTextSelection({ from: 4, to: 10 })
  return { local, editor, anchor: anchorSelection(editor.state)! }
}

// Where it shows after `edit` in the editing tab, a tab it reaches, and a doc opened after it
function shownInEveryTab(edit: (editor: Editor) => void) {
  const { local, editor, anchor } = threadAcrossParagraphs()
  const remote = new Y.Doc()
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local))
  const remoteEditor = openEditor(remote)
  edit(editor)
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local, Y.encodeStateVector(remote)))
  const fresh = new Y.Doc()
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(local))
  return [editor, remoteEditor, openEditor(fresh)].map((each) => shownText(each, anchor))
}

function deleteBetween(from: number, to: number) {
  return (editor: Editor) => {
    editor.commands.setTextSelection({ from, to })
    editor.commands.deleteSelection()
  }
}

describe('where a thread across two paragraphs shows after the tab holding it edits', () => {
  it.each([
    {
      name: 'joins the paragraphs',
      edit: (editor: Editor) => {
        editor.commands.setTextSelection(8)
        editor.commands.joinBackward()
      },
      shown: 'deleted',
    },
    { name: 'deletes across the paragraph break', edit: deleteBetween(5, 9), shown: 'deleted' },
    {
      name: 'deletes some of its words, leaving both paragraphs',
      edit: deleteBetween(4, 6),
      shown: 'cc',
    },
    {
      name: 'deletes all of its words, leaving both paragraphs',
      edit: (editor: Editor) => {
        deleteBetween(1, 6)(editor)
        deleteBetween(3, 5)(editor)
      },
      shown: '',
    },
    { name: 'leaves it alone', edit: () => {}, shown: 'bbcc' },
  ])('shows the same in every tab when it $name', ({ edit, shown }) => {
    expect(shownInEveryTab(edit)).toEqual([shown, shown, shown])
  })
})

describe('an anchor on the selection', () => {
  it('holds its first and last characters, so text typed at either edge stays outside', () => {
    const doc = new Y.Doc()
    const editor = openEditor(doc)
    editor.commands.setContent('<p>hello world</p><p>second line</p>')
    editor.commands.setTextSelection({ from: 7, to: 20 })
    const anchor = anchorSelection(editor.state)!

    editor.commands.insertContentAt(20, '!')
    editor.commands.insertContentAt(7, '[')

    expect([placeThread(editor.state, anchor), editor.getText({ blockSeparator: '|' })]).toEqual([
      { kind: 'text', from: 8, to: 21, quote: 'world second' },
      'hello [world|second! line',
    ])
  })

  it('names the characters at its ends for the saved check', () => {
    const doc = new Y.Doc()
    const editor = openEditor(doc)
    editor.commands.setContent('<p>hello world</p>')
    editor.commands.setTextSelection({ from: 7, to: 12 })
    const text = paragraphText(doc)
    const [first, last] = [6, 10].map((index) => {
      const item = Y.createRelativePositionFromTypeIndex(text, index, 0).item!
      return [item.client, item.clock]
    })

    const ends = anchorEnds(anchorSelection(editor.state)!).map((id) => [id.client, id.clock])

    expect(ends).toEqual([first, last])
  })

  it('is none for an empty selection, and a document anchor has no ends', () => {
    const editor = openEditor()
    editor.commands.setContent('<p>hello</p>')
    editor.commands.setTextSelection(3)

    expect([anchorSelection(editor.state), anchorEnds(DOCUMENT_ANCHOR)]).toEqual([null, []])
  })
})

const MENTION = '<span class="mention" data-type="mention" data-id="u1" data-label="Ann"></span>'

describe("an anchor's quote", () => {
  it('reads a mention as the editor writes it out', () => {
    const editor = openWriterEditor(`<p>hi ${MENTION} there</p>`)

    expect(quoteOf(editor, 1, 11)).toBe('hi @Ann there')
  })

  it('quotes a lone mention by its own text', () => {
    const editor = openWriterEditor(`<p>a${MENTION}b</p>`)

    expect(quoteOf(editor, 2, 3)).toBe('@Ann')
  })

  it('reads a tag and a line break as the editor writes them out', () => {
    const tag = '<span class="tag-item" data-tag-id="t1" data-tag-label="urgent"></span>'
    const editor = openWriterEditor(`<p>see ${tag}<br>now</p>`)

    expect(quoteOf(editor, 1, 10)).toBe('see #urgent\nnow')
  })
})
