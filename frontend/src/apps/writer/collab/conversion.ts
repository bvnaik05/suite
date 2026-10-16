import { generateJSON, getSchema } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import { placeFragment, prosemirrorToYXmlFragment } from '@tiptap/y-tiptap'
import {
  applyUpdate,
  ContentString,
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

/** What the conversion couldn't carry over: a part the editor can't hold, or text Yjs held back. */
export type Dropped =
  { kind: 'node'; name: string; text: string } | { kind: 'pending'; text: string }

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

// Text in changes Yjs keeps waiting, in its V2 encoding, for earlier ones that were never stored
function pendingText(doc: Doc) {
  const pending = doc.store.pendingStructs
  if (!pending) {
    return ''
  }

  return decodeUpdateV2(pending.update).structs.map(insertedString).join('')
}

function nameOf(type: AbstractType<unknown>) {
  if (type instanceof XmlElement) {
    return type.nodeName
  }

  return 'text'
}

function dropNames(lost: AbstractType<unknown>[]): Dropped[] {
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

function yAtomNames(type: AbstractType<unknown>): string[] {
  if (!(type instanceof XmlElement || type instanceof XmlFragment)) {
    return []
  }

  const inner = type.toArray().flatMap(yAtomNames)
  if (type instanceof XmlElement && isAtomName(type.nodeName)) {
    inner.push(type.nodeName)
  }

  return inner
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

function decoded(legacy: LegacyBody) {
  if (legacy.collab === 0 || !legacy.content) {
    return null
  }

  const old = new Doc()
  try {
    applyUpdate(
      old,
      Uint8Array.from(atob(legacy.content), (char) => char.charCodeAt(0)),
    )
  } catch {
    // Bytes Yjs can't read leave the HTML
    return null
  }

  return old
}

function fromYjs(old: Doc) {
  const body = old.getXmlFragment(BODY_FIELD)
  convertOldMedia(body)
  const { node, lost } = placeFragment(body, schema)
  const dropped = dropNames(lost)
  const pending = pendingText(old)
  if (pending) {
    dropped.push({ kind: 'pending', text: pending })
  }

  const sourceAtoms = yAtomNames(body)
  return {
    node,
    dropped,
    sourceText: textOf(body),
    sourceAtoms,
    droppedAtoms: lost.flatMap(yAtomNames),
  }
}

const atomRules = Object.values(schema.nodes)
  .filter((type) => isAtomName(type.name))
  .flatMap((type) => (type.spec.parseDOM ?? []).map((rule) => ({ rule, name: type.name })))

const MEDIA_TAGS = 'iframe, audio, video, img, object, embed'

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
  return { node, dropped: [] as Dropped[], sourceText, sourceAtoms, droppedAtoms: [] as string[] }
}

function read(legacy: LegacyBody) {
  const old = decoded(legacy)
  if (old) {
    return { ...fromYjs(old), from: 'yjs' as const }
  }

  return { ...fromHtml(legacy.html ?? ''), from: 'html' as const }
}

function textWithoutAtoms(node: PMNode) {
  return node.textBetween(0, node.content.size, '', () => '')
}

/** The old document as a fresh collaborative body, checked to hold the old text and atoms apart from what it drops. */
export function convertLegacy(legacy: LegacyBody, maxState: number): Converted {
  const { node, dropped, sourceText, sourceAtoms, droppedAtoms, from } = read(legacy)
  const converted = withHeadingIds(node)
  const fresh = new Doc()
  // Old comment marks are carried over as they are
  prosemirrorToYXmlFragment(converted, fresh.getXmlFragment(BODY_FIELD))
  const droppedText = dropped
    .filter((drop) => drop.kind === 'node')
    .map((drop) => drop.text)
    .join('')
  const isTextKept =
    characters(sourceText) === characters(textWithoutAtoms(converted) + droppedText)
  const isAtomsKept = tally(sourceAtoms) === tally([...atomNames(converted), ...droppedAtoms])
  if (!isTextKept || !isAtomsKept) {
    return { kind: 'failed', reason: 'check' }
  }

  const state = encodeStateAsUpdate(fresh)
  if (state.byteLength > maxState) {
    return { kind: 'failed', reason: 'too_large' }
  }

  return { kind: 'converted', state, dropped, from }
}
