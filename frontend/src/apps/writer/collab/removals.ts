import { APPLIED_UPDATE, type CollabRoom } from '@suite/collab-client'
import * as Y from 'yjs'

import { BODY_FIELD } from './field'

/** Origin of the edit that puts a removed piece of text back. */
export const TYPE_BACK = Symbol('writer-type-back')

// Yjs exports no DeleteSet type
type DeleteSet = ReturnType<typeof Y.createDeleteSet>
type DecodedRow = ReturnType<typeof Y.decodeUpdate>

// Shorter text can match in the wrong place, so it's reported instead
const MIN_SEEN_LENGTH = 3

/** Lost text at its offset in `seen`, with the formats it had. */
export interface Run {
  offset: number
  text: string
  attrs: Record<string, unknown>
}

/** The row wrote each client's clocks from `before` up to `after`. */
export interface RowClocks {
  before: Map<number, number>
  after: Map<number, number>
}

/**
 * Something of mine a remote row removed without naming it, because the row
 * deleted the block around it. `seen` is the text the row deleted next to mine,
 * and each run sits at its offset in `seen`.
 */
export type Removal =
  | { kind: 'text'; seen: string; runs: Run[]; written: RowClocks; isUncertain: boolean }
  | { kind: 'node'; name: string; attrs: Record<string, unknown> }

/**
 * Types back what the room's pulled rows removed of its work, or hands it to `report`
 * when there's no single place or the room can't write. Returns a stop function.
 */
export function watchRemovals(
  room: Pick<CollabRoom, 'doc' | 'ownClients' | 'canWrite' | 'onChange'>,
  report: (removals: Removal[]) => void,
) {
  const found: Removal[] = []
  function collect(transaction: Y.Transaction) {
    const updates: Uint8Array[] | undefined = transaction.meta.get(APPLIED_UPDATE)
    if (updates) {
      found.push(...findRemovals(transaction, updates, room.ownClients))
    }
  }

  // The room tells its listeners after a pull's catch, so a suspect room can't write by then
  function placeOrReport() {
    const unplaced = typeBackAll(room, found.splice(0))
    if (unplaced.length) {
      report(unplaced)
    }
  }

  room.doc.on('afterTransaction', collect)
  const stopListening = room.onChange(placeOrReport)
  return () => {
    room.doc.off('afterTransaction', collect)
    stopListening()
    // Removals the room never told of, as when it closed mid-adopt, can no longer be typed back
    const untold = found.splice(0)
    if (untold.length) {
      report(untold)
    }
  }
}

// Returns the removals it couldn't type back
function typeBackAll(room: Pick<CollabRoom, 'doc' | 'canWrite'>, removals: Removal[]) {
  if (!room.canWrite) {
    return removals
  }

  const body = room.doc.getXmlFragment(BODY_FIELD)
  return removals.filter((removal) => !typeBack(body, removal))
}

/**
 * Text and nodes of the clients in `mine` that `transaction` deleted though none of its
 * `updates` named them. Call from afterTransaction: deleted text is collected right after it.
 */
export function findRemovals(
  transaction: Y.Transaction,
  updates: Uint8Array[],
  mine: ReadonlySet<number>,
): Removal[] {
  const deleted = myDeletedItems(transaction, mine)
  if (!deleted.length) {
    return []
  }

  const rows = updates.map((update) => Y.decodeUpdate(update))
  const named = Y.mergeDeleteSets(rows.map((row) => row.ds))
  const removals: Removal[] = []
  const texts = new Set<Y.AbstractType<unknown>>()
  for (const item of deleted) {
    const element = elementIn(item)
    if (item.content instanceof Y.ContentString && hasUnnamed(item, named)) {
      texts.add(item.parent as Y.AbstractType<unknown>)
    } else if (element && !Y.isDeleted(named, item.id)) {
      removals.push({ kind: 'node', name: element.nodeName, attrs: rawAttrs(element) })
    }
  }

  for (const text of texts) {
    removals.push(textRemoval(text, transaction, rows, named, mine))
  }

  return removals
}

// Splits items at the delete boundaries; yjs merges them back after afterTransaction
function myDeletedItems(transaction: Y.Transaction, mine: ReadonlySet<number>) {
  const myDeletes = Y.createDeleteSet()
  for (const [client, ranges] of transaction.deleteSet.clients) {
    if (mine.has(client)) {
      myDeletes.clients.set(client, ranges)
    }
  }

  const deleted: Y.Item[] = []
  Y.iterateDeletedStructs(transaction, myDeletes, (struct) => {
    if (struct instanceof Y.Item) {
      deleted.push(struct)
    }
  })
  return deleted
}

function hasUnnamed(item: Y.Item, named: DeleteSet) {
  const { client, clock } = item.id
  const offsets = [...Array(item.length).keys()]
  return offsets.some((offset) => !Y.isDeleted(named, Y.createID(client, clock + offset)))
}

function elementIn(item: Y.Item) {
  const { content } = item
  if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
    return content.type
  }

  return null
}

// Reports must never be deduped against live text: the same words may be someone else's
function textRemoval(
  text: Y.AbstractType<unknown>,
  transaction: Y.Transaction,
  rows: DecodedRow[],
  named: DeleteSet,
  mine: ReadonlySet<number>,
) {
  const removal = {
    kind: 'text' as const,
    seen: '',
    runs: [] as Run[],
    written: clocksOf([]),
    isUncertain: false,
  }
  const gaps = new Set<number>()
  let attrs: Record<string, unknown> = {}
  let run: Run | null = null
  const seenIds: Y.ID[] = []
  for (let item = text._start; item; item = item.right) {
    if (item.content instanceof Y.ContentFormat && wasLive(item, transaction)) {
      attrs = withFormat(attrs, item.content)
      run = null
    }

    if (!(item.content instanceof Y.ContentString)) {
      continue
    }

    for (let index = 0; index < item.length; index++) {
      const id = Y.createID(item.id.client, item.id.clock + index)
      const state = { ...charState(id, transaction, named, mine), attrs, id }
      run = addChar(removal, { gaps, seenIds }, run, item.content.str[index], state)
    }
  }

  const namingRows = rows.filter((row) => seenIds.some((id) => Y.isDeleted(row.ds, id)))
  removal.written = clocksOf(namingRows)
  removal.isUncertain = removal.runs.some((lost) => gaps.has(lost.offset))
  return removal
}

// Only the rows that deleted the old text wrote its copy; rows pulled with them may write around it
function clocksOf(rows: DecodedRow[]): RowClocks {
  const written: RowClocks = { before: new Map(), after: new Map() }
  for (const struct of rows.flatMap((row) => row.structs)) {
    if (struct instanceof Y.Skip) {
      continue
    }

    const { client, clock } = struct.id
    written.before.set(client, Math.min(written.before.get(client) ?? clock, clock))
    written.after.set(client, Math.max(written.after.get(client) ?? 0, clock + struct.length))
  }

  return written
}

// Lost: deleted without the row naming it, mine or someone else's. Seen: deleted and named by the row
function charState(
  id: Y.ID,
  transaction: Y.Transaction,
  named: DeleteSet,
  mine: ReadonlySet<number>,
) {
  const isDeletedNow = Y.isDeleted(transaction.deleteSet, id)
  const isNamed = Y.isDeleted(named, id)
  const isMine = mine.has(id.client)
  const isUnnamed = isDeletedNow && !isNamed
  return {
    isLost: isMine && isUnnamed,
    isOtherLost: !isMine && isUnnamed,
    isSeen: isDeletedNow && isNamed,
  }
}

function wasLive(item: Y.Item, transaction: Y.Transaction) {
  return !item.deleted || Y.isDeleted(transaction.deleteSet, item.id)
}

function withFormat(attrs: Record<string, unknown>, format: Y.ContentFormat) {
  const next = { ...attrs }
  if (format.value === null) {
    delete next[format.key]
  } else {
    next[format.key] = format.value
  }

  return next
}

interface CharState {
  id: Y.ID
  isLost: boolean
  isOtherLost: boolean
  isSeen: boolean
  attrs: Record<string, unknown>
}

// Returns the run the next lost char joins; `gaps` gets the offsets of other clients' lost chars
function addChar(
  removal: { seen: string; runs: Run[] },
  { gaps, seenIds }: { gaps: Set<number>; seenIds: Y.ID[] },
  run: Run | null,
  char: string,
  state: CharState,
) {
  if (state.isOtherLost) {
    gaps.add(removal.seen.length)
  }

  if (!state.isLost) {
    if (state.isSeen) {
      removal.seen += char
      seenIds.push(state.id)
    }

    return null
  }

  const current = run ?? { offset: removal.seen.length, text: '', attrs: state.attrs }
  if (!run) {
    removal.runs.push(current)
  }

  current.text += char
  return current
}

// getAttributes skips a deleted element's entries, so read the latest value of each key
function rawAttrs(element: Y.XmlElement) {
  const attrs: Record<string, unknown> = {}
  for (const [key, item] of element._map) {
    const values = item.content.getContent()
    attrs[key] = values[values.length - 1]
  }

  return attrs
}

/**
 * Puts a text removal back where exactly one run of text the same transaction
 * wrote equals `seen`. Returns false when there's no such place, or more than one,
 * or when the row also removed someone else's text at a run's offset without naming it.
 */
export function typeBack(body: Y.XmlFragment, removal: Removal) {
  if (removal.kind !== 'text' || removal.isUncertain || removal.seen.length < MIN_SEEN_LENGTH) {
    return false
  }

  const { seen, written } = removal
  const matches = liveTexts(body).flatMap((text) => placesIn(text, seen, written))
  if (matches.length !== 1) {
    return false
  }

  const [{ text, at }] = matches
  const runs = [...removal.runs].reverse()
  body.doc!.transact(() => {
    for (const run of runs) {
      // A copy, since insert sets every format it isn't given to null on the object
      text.insert(at + run.offset, run.text, { ...run.attrs })
    }
  }, TYPE_BACK)
  return true
}

function liveTexts(parent: Y.XmlFragment | Y.XmlElement): Y.XmlText[] {
  return parent.toArray().flatMap((child) => {
    if (child instanceof Y.XmlText) {
      return [child]
    }

    if (child instanceof Y.XmlElement) {
      return liveTexts(child)
    }

    return []
  })
}

// Each whole run of live chars the transaction wrote that equals `seen`
function placesIn(text: Y.XmlText, seen: string, written: RowClocks) {
  const places: { text: Y.XmlText; at: number }[] = []
  for (const span of rowSpans(text, written)) {
    if (span.text === seen) {
      places.push({ text, at: span.at })
    }
  }

  return places
}

function rowSpans(text: Y.XmlText, written: RowClocks) {
  const spans: { at: number; text: string }[] = []
  let span: { at: number; text: string } | null = null
  for (const [at, { char, isFromRow }] of liveChars(text, written).entries()) {
    if (!isFromRow) {
      span = null
      continue
    }

    if (!span) {
      span = { at, text: '' }
      spans.push(span)
    }

    span.text += char
  }

  return spans
}

function liveChars(text: Y.XmlText, written: RowClocks) {
  const chars: { char: string; isFromRow: boolean }[] = []
  for (let item = text._start; item; item = item.right) {
    if (item.deleted || !(item.content instanceof Y.ContentString)) {
      continue
    }

    const { client, clock } = item.id
    for (let index = 0; index < item.length; index++) {
      const isFromRow = wroteIn(written, client, clock + index)
      chars.push({ char: item.content.str[index], isFromRow })
    }
  }

  return chars
}

function wroteIn(written: RowClocks, client: number, clock: number) {
  const before = written.before.get(client) ?? 0
  const after = written.after.get(client) ?? 0
  return clock >= before && clock < after
}
