import type { Schema } from '@tiptap/pm/model'
import { initProseMirrorDoc, relativePositionToAbsolutePosition } from '@tiptap/y-tiptap'
import {
  createRelativePositionFromTypeIndex,
  XmlElement,
  XmlFragment,
  XmlText,
  type AbstractType,
  type RelativePosition,
} from 'yjs'

import { encodeAnchor } from '@/apps/writer/collab/anchors'

// The old comment mark, under its own name or the binding's name for an overlapping copy
const COMMENT_KEY = /^comment(--[a-zA-Z0-9+/=]{8})?$/

interface Run {
  type: AbstractType<unknown>
  from: number
  to: number
}

interface Insert {
  insert: unknown
  attributes?: Record<string, unknown>
}

// An embed takes one place in its text's indexes
function insertedText({ insert }: Insert) {
  if (typeof insert === 'string') {
    return insert
  }

  return ' '
}

function commentIds(attributes: Record<string, unknown> = {}) {
  return Object.entries(attributes)
    .filter(([key]) => COMMENT_KEY.test(key))
    .map(([, attrs]) => (attrs as { commentId?: unknown } | null)?.commentId)
    .filter((id): id is string => typeof id === 'string' && !!id)
}

function textRuns(text: XmlText) {
  const runs: [string, Run][] = []
  let from = 0
  for (const op of text.toDelta() as Insert[]) {
    const to = from + insertedText(op).length
    runs.push(
      ...commentIds(op.attributes).map((id): [string, Run] => [id, { type: text, from, to }]),
    )
    from = to
  }

  return runs
}

// An inline atom such as a mention keeps its comment in its attributes and its place by index
function atomRuns(parent: AbstractType<unknown>, child: unknown, index: number): [string, Run][] {
  if (!(child instanceof XmlElement)) {
    return []
  }

  const run = { type: parent, from: index, to: index + 1 }
  return commentIds(child.getAttributes()).map((id): [string, Run] => [id, run])
}

function commentRuns(type: AbstractType<unknown>): [string, Run][] {
  if (type instanceof XmlText) {
    return textRuns(type)
  }

  if (!(type instanceof XmlElement || type instanceof XmlFragment)) {
    return []
  }

  return type
    .toArray()
    .flatMap((child, index) => [...atomRuns(type, child, index), ...commentRuns(child)])
}

// A body just built from an editor document has no hidden parts
function placeOf(
  body: XmlFragment,
  built: ReturnType<typeof initProseMirrorDoc>,
  position: RelativePosition,
) {
  return relativePositionToAbsolutePosition(body.doc!, body, position, built.mapping, new Set())!
}

/** Each old comment's anchor in `body`, from the first character or atom its mark covers to the last. */
export function oldCommentAnchors(body: XmlFragment, schema: Schema): Record<string, string> {
  const built = initProseMirrorDoc(body, schema)
  const runs = new Map<string, Run[]>()
  for (const [id, run] of commentRuns(body)) {
    const known = runs.get(id) ?? []
    runs.set(id, [...known, run])
  }

  const anchors: Record<string, string> = {}
  for (const [id, [start, ...rest]] of runs) {
    const end = rest.at(-1) ?? start
    const from = createRelativePositionFromTypeIndex(start.type, start.from, 0)
    const to = createRelativePositionFromTypeIndex(end.type, end.to, -1)
    // Quoted as anchorSelection quotes the same words, mentions included
    const quote = built.doc.textBetween(placeOf(body, built, from), placeOf(body, built, to), ' ')
    anchors[id] = encodeAnchor(from, to, quote)
  }

  return anchors
}
