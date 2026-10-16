import * as Y from 'yjs'

/** Origin of the edit that puts a removed piece of text back. */
export const TYPE_BACK = Symbol('writer-type-back')

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
 * My text and nodes that `transaction` deleted though its `update` didn't name them.
 * Call from afterTransaction: deleted text is collected right after it.
 */
export function findRemovals(transaction: Y.Transaction, update: Uint8Array): Removal[] {
  const deleted = myDeletedItems(transaction)
  if (!deleted.length) {
    return []
  }

  const named = Y.decodeUpdate(update).ds
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
    removals.push(textRemoval(text, transaction, named))
  }

  return removals
}

// Splits items at the delete boundaries; yjs merges them back after afterTransaction
function myDeletedItems(transaction: Y.Transaction) {
  const me = transaction.doc.clientID
  const ranges = transaction.deleteSet.clients.get(me)
  const deleted: Y.Item[] = []
  if (!ranges) {
    return deleted
  }

  const mine = Y.createDeleteSet()
  mine.clients.set(me, ranges)
  Y.iterateDeletedStructs(transaction, mine, (struct) => {
    if (struct instanceof Y.Item) {
      deleted.push(struct)
    }
  })
  return deleted
}

function hasUnnamed(item: Y.Item, named: Y.DeleteSet) {
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
  named: Y.DeleteSet,
) {
  const written = { before: transaction.beforeState, after: transaction.afterState }
  const removal = {
    kind: 'text' as const,
    seen: '',
    runs: [] as Run[],
    written,
    isUncertain: false,
  }
  let attrs: Record<string, unknown> = {}
  let run: Run | null = null
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
      const state = { ...charState(id, transaction, named), attrs }
      run = addChar(removal, run, item.content.str[index], state)
    }
  }

  return removal
}

// Lost: deleted without the row naming it, mine or someone else's. Seen: deleted and named by the row
function charState(id: Y.ID, transaction: Y.Transaction, named: Y.DeleteSet) {
  const isDeletedNow = Y.isDeleted(transaction.deleteSet, id)
  const isNamed = Y.isDeleted(named, id)
  const isMine = id.client === transaction.doc.clientID
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
  isLost: boolean
  isOtherLost: boolean
  isSeen: boolean
  attrs: Record<string, unknown>
}

// Returns the run the next lost char joins
function addChar(
  removal: { seen: string; runs: Run[]; isUncertain: boolean },
  run: Run | null,
  char: string,
  state: CharState,
) {
  if (state.isOtherLost) {
    removal.isUncertain = true
  }

  if (!state.isLost) {
    if (state.isSeen) {
      removal.seen += char
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
 * or when the row also removed someone else's text there without naming it.
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
