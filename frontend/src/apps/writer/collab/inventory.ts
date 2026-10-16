import { XmlElement, XmlFragment, XmlText } from 'yjs'

// The binding's name for a copy of a mark that can overlap another of its kind
const OVERLAP_SUFFIX = /--[a-zA-Z0-9+/=]{8}$/

// A stored attribute or mark under its own name, whichever copy of it holds it
type Entry = [string, unknown]

interface Insert {
  insert: unknown
  attributes?: Record<string, unknown>
}

/** One character of a body's text with the formatting Yjs holds on it. */
export interface Character {
  char: string
  entries: Entry[]
}

/** An element of a body, or an embed in its text, with the attributes Yjs holds on it. */
export interface Piece {
  name: string
  entries: Entry[]
}

/** What a body holds that a reader would miss, in order: its text and its elements. */
export interface Inventory {
  characters: Character[]
  elements: Piece[]
}

function entriesOf(attributes: Record<string, unknown> = {}): Entry[] {
  return Object.entries(attributes)
    .filter(([, value]) => value != null)
    .map(([key, value]) => [key.replace(OVERLAP_SUFFIX, ''), value])
}

function addText(text: XmlText, found: Inventory) {
  for (const { insert, attributes } of text.toDelta() as Insert[]) {
    const entries = entriesOf(attributes)
    if (typeof insert !== 'string') {
      found.elements.push({ name: '#embed', entries })
      continue
    }

    for (const char of insert) {
      found.characters.push({ char, entries })
    }
  }
}

function addType(
  type: XmlElement | XmlFragment | XmlText,
  skipped: ReadonlySet<unknown>,
  found: Inventory,
) {
  if (skipped.has(type)) {
    return
  }

  if (type instanceof XmlText) {
    addText(type, found)
    return
  }

  // A type no node is built from, which the build sets aside
  if (!(type instanceof XmlElement || type instanceof XmlFragment)) {
    return
  }

  if (type instanceof XmlElement) {
    found.elements.push({ name: type.nodeName, entries: entriesOf(type.getAttributes()) })
  }

  for (const child of type.toArray()) {
    addType(child, skipped, found)
  }
}

/** What `body` holds, leaving out the types in `skipped` and all they hold. */
export function inventory(body: XmlFragment, skipped: ReadonlySet<unknown> = new Set()) {
  const found: Inventory = { characters: [], elements: [] }
  addType(body, skipped, found)
  return found
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Whether `held` keeps all of `wanted`, defaults it gained aside; a list keeps its items in order
function holdsValue(held: unknown, wanted: unknown): boolean {
  if (Array.isArray(wanted)) {
    return JSON.stringify(held) === JSON.stringify(wanted)
  }

  if (isPlainObject(wanted)) {
    return (
      isPlainObject(held) &&
      Object.entries(wanted).every(([key, inner]) => inner == null || holdsValue(held[key], inner))
    )
  }

  return Object.is(held, wanted)
}

// Whether `held` keeps every entry of `wanted`, each in an entry of its own
function holdsEntries(held: Entry[], wanted: Entry[]) {
  const free = [...held]
  return wanted.every(([name, value]) => {
    const at = free.findIndex(([other, kept]) => other === name && holdsValue(kept, value))
    if (at < 0) {
      return false
    }

    free.splice(at, 1)
    return true
  })
}

function isSamePiece(held: Piece, wanted: Piece) {
  return held.name === wanted.name && holdsEntries(held.entries, wanted.entries)
}

// The first source element with no match in order in the result, which may hold more
function firstUnkeptPiece(source: Piece[], result: Piece[]) {
  let at = 0
  for (const piece of source) {
    while (at < result.length && !isSamePiece(result[at], piece)) {
      at += 1
    }

    if (at === result.length) {
      return piece
    }

    at += 1
  }

  return null
}

function firstChangedChar(source: Character[], result: Character[]) {
  const at = source.findIndex((character, index) => character.char !== result[index]?.char)
  if (at < 0 && source.length !== result.length) {
    return source.length
  }

  return at
}

/** What of `source` the `result` doesn't keep, first of each kind; empty when it keeps it all. */
export function unkept(source: Inventory, result: Inventory) {
  const missing: string[] = []
  const changedAt = firstChangedChar(source.characters, result.characters)
  if (changedAt >= 0) {
    missing.push(`text at ${changedAt}`)
  } else {
    const unformatted = source.characters.findIndex(
      (character, index) => !holdsEntries(result.characters[index].entries, character.entries),
    )
    if (unformatted >= 0) {
      missing.push(`formatting at ${unformatted}`)
    }
  }

  const piece = firstUnkeptPiece(source.elements, result.elements)
  if (piece) {
    missing.push(`element ${piece.name}`)
  }

  return missing
}
