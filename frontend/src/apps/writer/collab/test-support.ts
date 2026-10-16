import { REMOTE } from '@suite/collab-client'
import { Editor, getSchema, type JSONContent } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { afterEach } from 'vitest'
import { ref } from 'vue'
import * as Y from 'yjs'

import { writerEditorExtensions } from '@/apps/writer/editor-extensions'
import { writerSchema } from '@/apps/writer/schema'

import { BODY_FIELD } from './field'
import { findRemovals, typeBack, type Removal } from './removals'

/** One open tab: its editor, the edits it hasn't sent yet, and what it reported. */
export interface Tab {
  ydoc: Y.Doc
  editor: Editor
  outbox: Uint8Array[]
  reported: Removal[]
}

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

export function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

export function stored(...content: JSONContent[]) {
  const schema = getSchema(writerSchema())
  const ydoc = prosemirrorJSONToYDoc(schema, { type: 'doc', content }, BODY_FIELD)
  return Y.encodeStateAsUpdate(ydoc)
}

export async function openTabs(state: Uint8Array, count: number) {
  const tabs = [...Array(count).keys()].map((index) => openTab(state, index + 1))
  await settle()
  return tabs
}

function openTab(state: Uint8Array, clientID: number): Tab {
  const ydoc = new Y.Doc()
  ydoc.clientID = clientID
  Y.applyUpdate(ydoc, state, REMOTE)
  const extensions = writerEditorExtensions({
    collaborative: true,
    mentionItems: () => [],
    onMentionQuery: () => {},
    onCommentActivated: () => {},
    onAnchors: () => {},
    scrollParent: () => window,
    media: null,
    activeComment: ref(null),
    showComments: ref(false),
    showResolved: ref(false),
    edited: ref(false),
    onCommentsPainted: () => {},
  })
  const element = document.createElement('div')
  document.body.append(element)
  const collaboration = Collaboration.configure({ document: ydoc, field: BODY_FIELD })
  const editor = new Editor({ element, extensions: [...extensions, collaboration] })
  editors.push(editor)
  const tab: Tab = { ydoc, editor, outbox: [], reported: [] }
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) {
      tab.outbox.push(update)
    }
  })
  return tab
}

/** The tab's unsent edits as one row, as its outbox pushes them. */
export function sendRow(tab: Tab) {
  if (!tab.outbox.length) {
    return null
  }

  return Y.mergeUpdates(tab.outbox.splice(0))
}

/** Applies a row the way the puller does, then types back or reports what it removed. */
export function receiveRow(tab: Tab, row: Uint8Array) {
  const found: { transaction: Y.Transaction; removals: Removal[] }[] = []
  function detect(transaction: Y.Transaction) {
    if (transaction.origin === REMOTE) {
      found.push({ transaction, removals: findRemovals(transaction, row) })
    }
  }

  tab.ydoc.on('afterTransaction', detect)
  Y.applyUpdate(tab.ydoc, row, REMOTE)
  tab.ydoc.off('afterTransaction', detect)
  const body = tab.ydoc.getXmlFragment(BODY_FIELD)
  for (const { transaction, removals } of found) {
    const unplaced = removals.filter((removal) => !typeBack(body, removal, transaction))
    tab.reported.push(...unplaced)
  }
}

/** Delivers rows in server order: every tab but the sender receives each one. */
export async function deliver(tabs: Tab[], rows: [Tab, Uint8Array | null][]) {
  for (const [sender, row] of rows) {
    if (!row) {
      continue
    }

    for (const tab of tabs.filter((other) => other !== sender)) {
      receiveRow(tab, row)
    }

    await settle()
  }
}

/** Sends every unsent edit until no tab has any left. */
export async function syncAll(tabs: Tab[]) {
  for (let round = 0; round < 8; round++) {
    const rows = tabs.map((tab): [Tab, Uint8Array | null] => [tab, sendRow(tab)])
    if (rows.every(([, row]) => !row)) {
      return
    }

    await deliver(tabs, rows)
  }

  throw new Error('tabs still sending after 8 rounds')
}

/** Each textblock as "<type> <text>", in document order. */
export function blocks(tab: Tab) {
  const found: string[] = []
  tab.editor.state.doc.descendants((node) => {
    if (!node.isTextblock) {
      return true
    }

    found.push([node.type.name, node.textContent].join(' '))
    return false
  })
  return found
}

/** The document position just inside `word`, plus `offset`. */
export function inside(tab: Tab, word: string, offset = 1) {
  let found = -1
  tab.editor.state.doc.descendants((node, position) => {
    if (found < 0 && node.isText && node.text!.includes(word)) {
      found = position + node.text!.indexOf(word)
    }

    return found < 0
  })
  return found + offset
}
