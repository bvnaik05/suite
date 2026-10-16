import { generateJSON, getSchema } from '@tiptap/core'
import { DOMSerializer, type Node as PMNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import {
  placeFragment,
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from '@tiptap/y-tiptap'
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
import { domInventory, inventory, unkept } from '@/apps/writer/collab/inventory'
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

function isContent(type: AbstractType<unknown>) {
  if (type instanceof XmlText) {
    return type.length > 0
  }

  return (
    type instanceof XmlElement &&
    (isAtomName(type.nodeName) || Object.keys(type.getAttributes()).length > 0)
  )
}

// A lost part holds content when it, or anything in it, is text, an atom or a stored attribute
function holdsContent(part: AbstractType<unknown>) {
  if (isContent(part)) {
    return true
  }

  return part instanceof XmlElement && !part.createTreeWalker(isContent).next().done
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

// A line break the HTML parser had nowhere to put loses no words, so breaks aren't counted
function isAtomName(name: string) {
  const type = schema.nodes[name]
  return !!type && type.isLeaf && !type.isText && name !== 'hardBreak'
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
function mediaSources(body: XmlFragment) {
  const media = [
    ...body.createTreeWalker((type) => type instanceof XmlElement && MEDIA.has(type.nodeName)),
  ] as XmlElement[]
  return JSON.stringify(media.map((element) => element.getAttribute('src')))
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
// aside holding nothing, hidden or lost (recorded), left out of the source, so a lost part with
// content fails; and the extras the result may hold, being the filler the build adds, declared
// defaults and heading ids
function fromYjs(old: Doc) {
  const hasUnreadableThreads = unreadableThreads(old).length > 0
  const body = old.getXmlFragment(BODY_FIELD)
  const media = mediaSources(body)
  convertOldMedia(body)
  dropDriveDefaults(body)
  const { node, hidden, lost } = placeFragment(body, schema)
  const isMediaKept = mediaSources(body) === media
  const source = inventory(
    body,
    new Set([...hidden, ...lost.filter((part) => !holdsContent(part))]),
  )
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

// Drive's comment marks, holding a whole thread or an annotation id
const OLD_THREAD_TAGS = 'span[data-comment], span[data-annotation-id]'

function atomNameOf(element: Element) {
  const found = atomRules.find(
    ({ rule }) => element.matches(rule.tag) && rule.getAttrs?.(element as HTMLElement) !== false,
  )
  return found?.name
}

// Drive's ink, which it stored as the colour of text left at its default
const DRIVE_INK = 'rgb(31, 39, 46)'

// Drive stored its indent on every block and its ink on default text; a highlight also kept its
// colour in data-color, which the editor reads from the style
function dropDriveHtmlDefaults(body: HTMLElement) {
  for (const block of body.querySelectorAll<HTMLElement>('p, h1, h2, h3, h4, h5, h6')) {
    if (block.style.getPropertyValue('margin-left') === '0px') {
      block.style.removeProperty('margin-left')
    }
  }

  for (const element of body.querySelectorAll<HTMLElement>('[style]')) {
    if (element.style.getPropertyValue('color') === DRIVE_INK) {
      element.style.removeProperty('color')
    }
  }

  for (const mark of body.querySelectorAll<HTMLElement>('mark[data-color]')) {
    if (mark.style.getPropertyValue('background-color')) {
      mark.removeAttribute('data-color')
    }
  }
}

// The fresh body as the editor draws it
function drawn(fresh: XmlFragment) {
  const { content } = yXmlFragmentToProseMirrorRootNode(fresh, schema)
  return DOMSerializer.fromSchema(schema).serializeFragment(content)
}

// The check compares the old HTML, Drive's defaults dropped, with the fresh body as the editor draws
// it; an atom's own words live in its attributes and count as no text, and whitespace and line
// breaks aren't compared
function fromHtml(html: string) {
  const node = schema.nodeFromJSON(generateJSON(html, extensions))
  const { body } = new DOMParser().parseFromString(html, 'text/html')
  const hasUnreadableThreads = !!body.querySelector(OLD_THREAD_TAGS)
  dropDriveHtmlDefaults(body)
  const source = domInventory(body, atomNameOf)
  return {
    node,
    dropped: [] as Dropped[],
    hasUnreadableThreads,
    isKept: (fresh: XmlFragment) => !unkept(source, domInventory(drawn(fresh), atomNameOf)).length,
  }
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

/** The old document as a fresh collaborative body, checked to hold the old text, formatting and parts apart from what it drops. */
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
  if (!isKept(body)) {
    return { kind: 'failed', reason: 'check' }
  }

  const state = encodeStateAsUpdate(fresh)
  if (state.byteLength > maxState) {
    return { kind: 'failed', reason: 'too_large' }
  }

  return { kind: 'converted', state, dropped, from }
}
