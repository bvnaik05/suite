import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { initProseMirrorDoc, relativePositionToAbsolutePosition } from '@tiptap/y-tiptap'
import {
  createRelativePositionFromTypeIndex,
  XmlElement,
  XmlFragment,
  XmlText,
  type AbstractType,
  type Doc,
  type RelativePosition,
} from 'yjs'

import { encodeAnchor } from '@/apps/writer/collab/anchors'
import { BODY_FIELD } from '@/apps/writer/collab/field'
import { quoteBetween } from '@/apps/writer/collab/places'

// The old comment mark, which excludes itself, so the binding keeps it under its own name
const COMMENT_KEY = 'comment'
// The comment mark under its own name or a hashed copy, which the binding shouldn't write
const ANY_COMMENT_KEY = /^comment(--[a-zA-Z0-9+/=]{8})?$/

// Drive's later comment mark, which could overlap itself (`excludes: ''`), so the binding keeps
// each under a hashed name; and the list its threads were kept in
const ANNOTATION_KEY = /^annotation(--[a-zA-Z0-9+/=]{8})?$/
const ANNOTATIONS_ROOT = 'docAnnotations'

// Drive's comment marks in HTML, holding a whole thread or an annotation id
export const OLD_THREAD_TAGS = 'span[data-comment], span[data-annotation-id]'

interface Run {
  type: AbstractType<unknown>
  from: number
  to: number
}

interface PlacedRun {
  from: RelativePosition
  to: RelativePosition
  fromPlace: number
  toPlace: number
}

// The binding keeps inline nodes as elements, so a text holds only strings; conversion reads only
// the body the binding wrote
interface Insert {
  insert: string
  attributes?: Record<string, unknown>
}

function threadId(attrs: unknown): string | undefined {
  const id = (attrs as { commentId?: unknown } | null)?.commentId
  if (typeof id === 'string' && id.trim()) {
    return id
  }

  return undefined
}

// An annotation, or a comment mark with no thread id, as Drive's earlier one that held its whole thread
function isUnreadableMark([key, attrs]: [string, unknown]) {
  return ANNOTATION_KEY.test(key) || (ANY_COMMENT_KEY.test(key) && threadId(attrs) === undefined)
}

function markEntries(type: AbstractType<unknown>): [string, unknown][] {
  if (type instanceof XmlText) {
    return (type.toDelta() as Insert[]).flatMap((op) => Object.entries(op.attributes ?? {}))
  }

  if (type instanceof XmlElement) {
    return [...Object.entries(type.getAttributes()), ...type.toArray().flatMap(markEntries)]
  }

  if (type instanceof XmlFragment) {
    return type.toArray().flatMap(markEntries)
  }

  return []
}

/** The old comment marks and annotations in `old` that no thread can be made from yet */
export function unreadableThreads(old: Doc) {
  const found = markEntries(old.getXmlFragment(BODY_FIELD))
    .filter(isUnreadableMark)
    .map(([key]) => key)
  if (old.share.has(ANNOTATIONS_ROOT) && old.getArray(ANNOTATIONS_ROOT).length) {
    found.push(ANNOTATIONS_ROOT)
  }

  return found
}

function textRuns(text: XmlText) {
  const runs: [string, Run][] = []
  let from = 0
  for (const { insert, attributes } of text.toDelta() as Insert[]) {
    const to = from + insert.length
    const id = threadId(attributes?.[COMMENT_KEY])
    if (id !== undefined) {
      runs.push([id, { type: text, from, to }])
    }

    from = to
  }

  return runs
}

// An inline atom such as a mention keeps its comment in its attributes and its place by index
function atomRuns(
  parent: AbstractType<unknown>,
  child: unknown,
  index: number,
  schema: Schema,
): [string, Run][] {
  if (!(child instanceof XmlElement && schema.nodes[child.nodeName]?.isInline)) {
    return []
  }

  const id = threadId(child.getAttribute(COMMENT_KEY))
  if (id === undefined) {
    return []
  }

  return [[id, { type: parent, from: index, to: index + 1 }]]
}

function commentRuns(type: AbstractType<unknown>, schema: Schema): [string, Run][] {
  if (type instanceof XmlText) {
    return textRuns(type)
  }

  if (!(type instanceof XmlElement || type instanceof XmlFragment)) {
    return []
  }

  return type
    .toArray()
    .flatMap((child, index) => [
      ...atomRuns(type, child, index, schema),
      ...commentRuns(child, schema),
    ])
}

// Where the editor shows `position`, or null when it can't
function placeOf(
  body: XmlFragment,
  built: ReturnType<typeof initProseMirrorDoc>,
  position: RelativePosition,
) {
  const { mapping, meta } = built
  return relativePositionToAbsolutePosition(body.doc!, body, position, mapping, meta.hidden)
}

function placedRun(
  body: XmlFragment,
  built: ReturnType<typeof initProseMirrorDoc>,
  run: Run,
): PlacedRun | null {
  const from = createRelativePositionFromTypeIndex(run.type, run.from, 0)
  const to = createRelativePositionFromTypeIndex(run.type, run.to, -1)
  const fromPlace = placeOf(body, built, from)
  const toPlace = placeOf(body, built, to)
  if (fromPlace === null || toPlace === null || fromPlace >= toPlace) {
    return null
  }

  return { from, to, fromPlace, toPlace }
}

// Runs in one textblock, or with only block boundaries between them, are one stretch; any leaf
// between them, a hard break or an image as well, counts as content
function joins(doc: PMNode, before: PlacedRun, after: PlacedRun) {
  const end = before.toPlace
  const start = after.fromPlace
  return (
    doc.resolve(end).parent === doc.resolve(start).parent ||
    doc.textBetween(end, start, '', '\ufffc') === ''
  )
}

// Old Writer copied a comment's mark with its words, so one id can sit in places far apart
function firstStretch(doc: PMNode, runs: PlacedRun[]) {
  const end = runs.findIndex((run, index) => index > 0 && !joins(doc, runs[index - 1], run))
  if (end < 0) {
    return runs
  }

  return runs.slice(0, end)
}

// Each stretch of a comment's runs, in order, with its words
function stretches(doc: PMNode, runs: PlacedRun[]) {
  const found: { start: PlacedRun; end: PlacedRun; quote: string }[] = []
  let left = runs
  while (left.length) {
    const stretch = firstStretch(doc, left)
    const start = stretch[0]
    const end = stretch.at(-1)!
    found.push({ start, end, quote: quoteBetween(doc, start.fromPlace, end.toPlace) })
    left = left.slice(stretch.length)
  }

  return found
}

/**
 * Each old comment's anchor in `body`, from the first character or atom its mark covers to the
 * last of that stretch, and the words of its copies elsewhere; a comment the editor can't place
 * gets none
 */
export function oldCommentAnchors(body: XmlFragment, schema: Schema) {
  const built = initProseMirrorDoc(body, schema)
  const runs = new Map<string, (PlacedRun | null)[]>()
  for (const [id, run] of commentRuns(body, schema)) {
    const known = runs.get(id) ?? []
    runs.set(id, [...known, placedRun(body, built, run)])
  }

  const anchors: Record<string, string> = {}
  const copies: { id: string; text: string }[] = []
  for (const [id, placed] of runs) {
    if (!placed.every((run): run is PlacedRun => run !== null)) {
      continue
    }

    const [first, ...rest] = stretches(built.doc, placed)
    anchors[id] = encodeAnchor(first.start.from, first.end.to, first.quote)
    copies.push(...rest.map(({ quote }) => ({ id, text: quote })))
  }

  return { anchors, copies }
}

/** Takes the old comment marks that carry a thread id off `body`; the ids it took them from */
export function dropCommentMarks(body: XmlFragment, schema: Schema) {
  const runs = commentRuns(body, schema)
  for (const [, { type, from, to }] of runs) {
    if (type instanceof XmlText) {
      type.format(from, to - from, { [COMMENT_KEY]: null })
    } else if (type instanceof XmlElement || type instanceof XmlFragment) {
      ;(type.get(from) as XmlElement).removeAttribute(COMMENT_KEY)
    }
  }

  return runs.map(([id]) => id)
}
