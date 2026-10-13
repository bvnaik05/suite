import type { EditorState } from '@tiptap/pm/state'
import { relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap'
import * as Y from 'yjs'

import { readAnchor } from './anchors'

/** Where a thread shows in this tab. */
export type ThreadPlace =
  | { kind: 'document' }
  | { kind: 'text'; from: number; to: number; quote: string }
  // An end's text hasn't reached this tab yet
  | { kind: 'arriving'; quote: string }
  // Every character it was made on is deleted
  | { kind: 'deleted'; quote: string }
  // An old comment moved over without its place
  | { kind: 'unplaced' }

/** Finds a thread's text in the editor: the part of it still there, never anything outside it. */
export function placeThread(state: EditorState, anchor: string): ThreadPlace {
  const read = readAnchor(anchor)
  if (read.kind !== 'text') {
    return read
  }

  const sync = ySyncPluginKey.getState(state)
  const hasArrived = sync?.binding && isInDoc(sync.doc, read.start) && isInDoc(sync.doc, read.end)
  if (!hasArrived) {
    return { kind: 'arriving', quote: read.quote }
  }

  const { doc, type, binding } = sync
  const from = relativePositionToAbsolutePosition(doc, type, read.start, binding.mapping)
  const to = relativePositionToAbsolutePosition(doc, type, read.end, binding.mapping)
  if (from === null || to === null || from >= to) {
    return { kind: 'deleted', quote: read.quote }
  }

  return { kind: 'text', from, to, quote: read.quote }
}

// Yjs can't tell text not received yet from text deleted for good, so this asks first
function isInDoc(doc: Y.Doc, position: Y.RelativePosition) {
  const id = position.item ?? position.type
  return !id || Y.getState(doc.store, id.client) > id.clock
}
