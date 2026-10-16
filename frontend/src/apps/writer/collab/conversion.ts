import { generateJSON, getSchema } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import { placeFragment, prosemirrorToYXmlFragment } from '@tiptap/y-tiptap'
import {
  applyUpdate,
  ContentDeleted,
  ContentEmbed,
  ContentFormat,
  ContentString,
  ContentType,
  decodeUpdateV2,
  Doc,
  encodeStateAsUpdate,
  Item,
  XmlElement,
  XmlFragment,
  XmlText,
  type AbstractStruct,
  type AbstractType,
} from 'yjs'

import { BODY_FIELD } from '@/apps/writer/collab/field'
import { inventory, unkept, type Inventory } from '@/apps/writer/collab/inventory'
import { unreadableThreads } from '@/apps/writer/collab/old-comments'
import { convertOldMedia } from '@/apps/writer/collab/old-media'
import { renderedIds } from '@/apps/writer/extensions/heading-anchors'
import { writerSchema } from '@/apps/writer/schema'

const extensions = writerSchema()
const schema = getSchema(extensions)

/** An old Writer document as its row stores it. */
export interface LegacyBody {
  content: string | null
  html: string | null
  collab: number
}

/** What the conversion couldn't carry over: a part the editor can't hold, or a change Yjs held back. */
export type Dropped =
  { kind: 'node'; name: string; text: string } | { kind: 'pending'; text: string; parts: string[] }

export type Converted =
  | { kind: 'converted'; state: Uint8Array; dropped: Dropped[]; from: 'yjs' | 'html' }
  | { kind: 'failed'; reason: 'too_large' | 'check' }

function insertedText({ insert }: { insert: unknown }) {
  return typeof insert === 'string' ? insert : ''
}

function textOf(type: AbstractType<unknown>): string {
  if (type instanceof XmlText) {
    return type.toDelta().map(insertedText).join('')
  }

  if (type instanceof XmlElement || type instanceof XmlFragment) {
    return type.toArray().map(textOf).join('')
  }

  return ''
}

function insertedString(struct: AbstractStruct) {
  if (struct instanceof Item && struct.content instanceof ContentString) {
    return struct.content.str
  }

  return ''
}

function nameOf(type: AbstractType<unknown>) {
  if (type instanceof XmlElement) {
    return type.nodeName
  }

  return 'text'
}

// What a held-back change adds besides text: a part, a mark or an embed
function pendingPart(struct: AbstractStruct) {
  if (!(struct instanceof Item)) {
    return []
  }

  const { content } = struct
  if (content instanceof ContentType) {
    return [nameOf(content.type)]
  }

  // A mark's end is stored as the same key set to null
  if (content instanceof ContentFormat && content.value !== null) {
    return [`format ${content.key}`]
  }

  if (content instanceof ContentEmbed) {
    return ['embed']
  }

  const isTextOrNone = [ContentString, ContentDeleted, ContentFormat].some(
    (kind) => content instanceof kind,
  )
  if (isTextOrNone) {
    return []
  }

  return ['other']
}

// Changes Yjs keeps waiting, in its V2 encoding, for earlier ones that were never stored
function pendingDrop(doc: Doc): Dropped[] {
  const pending = doc.store.pendingStructs
  if (!pending) {
    return []
  }

  const { structs } = decodeUpdateV2(pending.update)
  const text = structs.map(insertedString).join('')
  const parts = [...new Set(structs.flatMap(pendingPart))]
  if (!text && !parts.length) {
    return []
  }

  return [{ kind: 'pending', text, parts }]
}

function lostParts(lost: AbstractType<unknown>[]): Dropped[] {
  return lost.map((type) => ({ kind: 'node', name: nameOf(type), text: textOf(type) }))
}

// The id each heading's anchor already has when drawn, so links to it keep working
function withHeadingIds(node: PMNode) {
  const nextRenderedId = renderedIds()
  const transform = new Transform(node)
  node.descendants((child, pos) => {
    const isBare =
      child.type.name === 'heading' && !!child.textContent && !child.attrs['data-toc-id']
    if (isBare) {
      transform.setNodeAttribute(pos, 'data-toc-id', nextRenderedId(child.textContent))
    }
  })
  return transform.doc
}

function tally(items: Iterable<string>) {
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1)
  }

  return [...counts].sort().join()
}

function characters(text: string) {
  return tally(text.replace(/\s/g, ''))
}

// A line break the HTML parser had nowhere to put loses no words, so breaks aren't counted
function isAtomName(name: string) {
  const type = schema.nodes[name]
  return !!type && type.isLeaf && !type.isText && name !== 'hardBreak'
}

function atomNames(node: PMNode) {
  const names: string[] = []
  node.descendants((child) => {
    if (isAtomName(child.type.name)) {
      names.push(child.type.name)
    }
  })
  return names
}

function decoded(content: string | null) {
  // A collaborative body with no Yjs state stored
  if (!content) {
    return null
  }

  const old = new Doc()
  try {
    applyUpdate(
      old,
      Uint8Array.from(atob(content), (char) => char.charCodeAt(0)),
    )
  } catch {
    // Bytes Yjs can't read leave the HTML
    return null
  }

  return old
}

const MEDIA = new Set(['resizableMedia', 'image', 'video'])

// Where each image and video points, in order
function mediaSources(found: Inventory) {
  const sources = found.elements
    .filter((piece) => MEDIA.has(piece.name))
    .map((piece) => Object.fromEntries(piece.entries).src)
  return JSON.stringify(sources)
}

// Drive stored its indent and heading line height at their defaults, which this editor has no attribute for
const DEFAULT_INDENTS = new Set<unknown>([0, '0'])

function dropDriveDefaults(body: XmlFragment) {
  const elements = [...body.createTreeWalker((type) => type instanceof XmlElement)] as XmlElement[]
  for (const element of elements) {
    if (DEFAULT_INDENTS.has(element.getAttribute('indent'))) {
      element.removeAttribute('indent')
    }

    if (element.nodeName === 'heading' && element.getAttribute('lineHeight') === '100%') {
      element.removeAttribute('lineHeight')
    }
  }
}

// The check compares the old body with the fresh one as Yjs holds both. Between them: convertOldMedia,
// checked on its own by where the media points; Drive's defaults, dropped; the parts the build set
// aside, lost (recorded) or hidden (holding nothing), left out of the source; and the extras the
// result may hold, being the filler the build adds, declared defaults and heading ids
function fromYjs(old: Doc) {
  const hasUnreadableThreads = unreadableThreads(old).length > 0
  const body = old.getXmlFragment(BODY_FIELD)
  const media = mediaSources(inventory(body))
  convertOldMedia(body)
  dropDriveDefaults(body)
  const { node, hidden, lost } = placeFragment(body, schema)
  const isMediaKept = mediaSources(inventory(body)) === media
  const source = inventory(body, new Set([...hidden, ...lost]))
  return {
    node,
    dropped: [...lostParts(lost), ...pendingDrop(old)],
    hasUnreadableThreads,
    isKept: (fresh: XmlFragment) => isMediaKept && !unkept(source, inventory(fresh)).length,
  }
}

const atomRules = Object.values(schema.nodes)
  .filter((type) => isAtomName(type.name))
  .flatMap((type) => (type.spec.parseDOM ?? []).map((rule) => ({ rule, name: type.name })))

const MEDIA_TAGS = 'iframe, audio, video, img, object, embed'

// Drive's comment marks, holding a whole thread or an annotation id
const OLD_THREAD_TAGS = 'span[data-comment], span[data-annotation-id]'

function atomNameOf(element: Element) {
  const found = atomRules.find(
    ({ rule }) => element.matches(rule.tag) && rule.getAttrs?.(element as HTMLElement) !== false,
  )
  return found?.name
}

// An atom's own words, such as a mention's label, live in its attributes and count as no text
function fromHtml(html: string) {
  const node = schema.nodeFromJSON(generateJSON(html, extensions))
  const { body } = new DOMParser().parseFromString(html, 'text/html')
  const hasUnreadableThreads = !!body.querySelector(OLD_THREAD_TAGS)
  const sourceAtoms: string[] = []
  for (const element of body.querySelectorAll('*')) {
    const name = body.contains(element) && atomNameOf(element)
    if (name) {
      sourceAtoms.push(name)
      element.remove()
    }
  }

  // Media no rule takes has nowhere to go, so it fails the atom check
  for (const element of body.querySelectorAll(MEDIA_TAGS)) {
    sourceAtoms.push(`<${element.localName}>`)
  }

  const sourceText = body.textContent ?? ''
  return {
    node,
    dropped: [] as Dropped[],
    hasUnreadableThreads,
    isKept: (fresh: XmlFragment, converted: PMNode) =>
      characters(sourceText) === characters(textWithoutAtoms(converted)) &&
      tally(sourceAtoms) === tally(atomNames(converted)),
  }
}

function textWithoutAtoms(node: PMNode) {
  return node.textBetween(0, node.content.size, '', () => '')
}

function read(legacy: LegacyBody) {
  // A body saved without collaboration has only its HTML
  if (legacy.collab !== 0) {
    const old = decoded(legacy.content)
    if (old) {
      return { ...fromYjs(old), from: 'yjs' as const }
    }
  }

  return { ...fromHtml(legacy.html ?? ''), from: 'html' as const }
}

/** The old document as a fresh collaborative body, checked to hold the old text and atoms apart from what it drops. */
export function convertLegacy(legacy: LegacyBody, maxState: number): Converted {
  const { node, dropped, hasUnreadableThreads, isKept, from } = read(legacy)
  if (hasUnreadableThreads) {
    return { kind: 'failed', reason: 'check' }
  }

  const converted = withHeadingIds(node)
  const fresh = new Doc()
  const body = fresh.getXmlFragment(BODY_FIELD)
  // Old comment marks are carried over as they are
  prosemirrorToYXmlFragment(converted, body)
  if (!isKept(body, converted)) {
    return { kind: 'failed', reason: 'check' }
  }

  const state = encodeStateAsUpdate(fresh)
  if (state.byteLength > maxState) {
    return { kind: 'failed', reason: 'too_large' }
  }

  return { kind: 'converted', state, dropped, from }
}
