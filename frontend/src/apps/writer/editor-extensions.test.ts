import { Editor } from '@tiptap/core'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import * as yjs from 'yjs'

import { bubbleMenuOptions } from './components/core-editor/bubble-menu'
import { writerEditorExtensions, type WriterEditorOptions } from './editor-extensions'

vi.mock('@/apps/writer/utils', () => ({ insertTemplate: () => {} }))
vi.mock('@/apps/writer/resources', () => ({ getTemplates: {} }))

function writerEditor(content: string, changes: Partial<WriterEditorOptions> = {}) {
  const ydoc = new yjs.Doc()
  const options: WriterEditorOptions = {
    isCollaborative: false,
    mentionItems: () => [],
    onMentionQuery: () => {},
    onCommentActivated: () => {},
    onAnchors: () => {},
    scrollParent: () => null,
    media: null,
    comments: ydoc.getMap('comments'),
    ydoc,
    activeComment: ref(null),
    showComments: ref(false),
    showResolved: ref(false),
    edited: ref(false),
    onCommentsPainted: () => {},
  }
  const extensions = writerEditorExtensions({ ...options, ...changes })
  return new Editor({ content, extensions })
}

describe('writer editor', () => {
  it('paints the styles of one selection onto another', () => {
    const editor = writerEditor('<p><strong>bold</strong> plain</p>')

    editor.commands.setTextSelection({ from: 1, to: 5 })
    editor.commands.storeStyles()
    editor.commands.setTextSelection({ from: 6, to: 11 })
    editor.commands.applyStyles()

    expect(editor.getHTML()).toContain('<strong>plain</strong>')
    editor.destroy()
  })
})

describe('collab editor without a comments map', () => {
  it('runs without the comment extension and still shows the bubble menu over a selection', () => {
    const editor = writerEditor('<p>plain text</p>', {
      isCollaborative: true,
      comments: undefined,
      ydoc: undefined,
    })
    editor.commands.setTextSelection({ from: 1, to: 6 })
    const { state } = editor
    const { from, to } = state.selection
    const names = editor.extensionManager.extensions.map((extension) => extension.name)

    expect(names).not.toContain('commentExtension')
    expect(bubbleMenuOptions({ comments: undefined }).shouldShow({ state, from, to })).toBe(true)
    editor.destroy()
  })
})

describe('bubble menu', () => {
  it('hides over a selection while a comment is being written', () => {
    const editor = writerEditor('<p>plain text</p>')
    editor.commands.setTextSelection({ from: 1, to: 6 })
    const { state } = editor
    const { from, to } = state.selection
    const comments = new yjs.Doc().getMap('comments')
    comments.set('old', { id: 'old' })
    comments.set('draft', { id: 'draft', new: true })

    expect(bubbleMenuOptions({ comments }).shouldShow({ state, from, to })).toBe(false)
    editor.destroy()
  })

  const CASES = [
    { label: 'no comments', entries: [], isShown: true },
    { label: 'a saved comment', entries: [{ id: 'old' }], isShown: true },
    { label: 'a comment being written', entries: [{ id: 'draft', new: true }], isShown: false },
    { label: 'a comment being edited', entries: [{ id: 'old', edit: true }], isShown: false },
  ]

  it.each(CASES)('over a selection with $label, shows: $isShown', ({ entries, isShown }) => {
    const editor = writerEditor('<p>plain text</p>')
    editor.commands.setTextSelection({ from: 1, to: 6 })
    const { state } = editor
    const { from, to } = state.selection
    const comments = new yjs.Doc().getMap('comments')
    for (const [index, entry] of entries.entries()) {
      comments.set(`comment-${index}`, entry)
    }

    expect(bubbleMenuOptions({ comments }).shouldShow({ state, from, to })).toBe(isShown)
    editor.destroy()
  })
})
