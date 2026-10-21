import { getSchema } from '@tiptap/core'
import { applyUpdate, Doc, XmlElement, XmlFragment, XmlText, type AbstractType } from 'yjs'

import { BODY_FIELD } from '@/apps/writer/collab/field'
import { writerSchema } from '@/apps/writer/schema'

const schema = getSchema(writerSchema())

/** An old Writer document as its row stores it. */
export interface LegacyBody {
  content: string | null
  html: string | null
  collab: number
}

export function isContent(type: AbstractType<unknown>) {
  if (type instanceof XmlText) {
    return type.length > 0
  }

  return (
    type instanceof XmlElement &&
    (isAtomName(type.nodeName) || Object.keys(type.getAttributes()).length > 0)
  )
}

// Drive's table of contents, drawn from the headings, stores only the hint it showed
const OLD_TOC = 'tocNode'

export function isHintOnlyToc(part: AbstractType<unknown>) {
  return (
    part instanceof XmlElement &&
    part.nodeName === OLD_TOC &&
    Object.keys(part.getAttributes()).every((key) => key === 'placeholder') &&
    !!part.createTreeWalker(isContent).next().done
  )
}

// Blocks that hold no words when empty, and the line break, which never does
const WORDLESS = new Set(['paragraph', 'heading', 'hardBreak'])

function isWordOrPart(type: AbstractType<unknown>) {
  if (type instanceof XmlText) {
    return type.length > 0
  }

  if (isHintOnlyToc(type)) {
    return false
  }

  // An atom or media holds its data whatever stray children it has
  return (
    type instanceof XmlElement &&
    (isAtomName(type.nodeName) ||
      MEDIA.has(type.nodeName) ||
      (!type.length && !WORDLESS.has(type.nodeName)))
  )
}

// No words, embeds or parts; what empty blocks store, like a heading's level, isn't counted
function holdsNothing(body: XmlFragment) {
  return !!body.createTreeWalker(isWordOrPart).next().done
}

// A line break the HTML parser had nowhere to put loses no words, so breaks aren't counted
export function isAtomName(name: string) {
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

export const MEDIA = new Set(['resizableMedia', 'image', 'video'])

/** The store an old document is read from: its Yjs body, or its HTML, past a Yjs body holding nothing. */
export type LegacyRead =
  { from: 'yjs'; old: Doc } | { from: 'html'; html: string; emptyYjs: Doc | null }

/** Which of an old document's stores the conversion and the read-only view read. */
export function readLegacy(legacy: LegacyBody): LegacyRead {
  const html = legacy.html ?? ''
  // A body saved without collaboration has only its HTML
  if (legacy.collab !== 0) {
    const old = decoded(legacy.content)
    if (old && holdsNothing(old.getXmlFragment(BODY_FIELD))) {
      return { from: 'html', html, emptyYjs: old }
    }

    if (old) {
      return { from: 'yjs', old }
    }
  }

  return { from: 'html', html, emptyYjs: null }
}
