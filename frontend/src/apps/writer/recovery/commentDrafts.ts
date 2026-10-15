/**
 * Comments written on a document's text and not yet taken by Drive, kept on
 * this device per person and document until Drive takes them or their author
 * discards them. Blocked storage keeps nothing and never throws.
 */
export interface CommentDraft {
  // Made here and sent with every try, so a resend never posts twice
  clientId: string
  anchor: string
  text: string
  // Comment was pressed, so the words stay as sent and any later send is a retry
  isSent: boolean
}

const PREFIX = 'suite:writer-comment-drafts:'

/** The drafts this person has on this device for one document, oldest first. */
export function readDrafts(user: string, node: string): CommentDraft[] {
  try {
    return parseDrafts(localStorage.getItem(keyOf(user, node)))
  } catch {
    return []
  }
}

/** The client ids of the drafts another tab took out of this person's drafts for the document. */
export function removedElsewhere(user: string, node: string, event: StorageEvent) {
  if (event.key !== keyOf(user, node)) {
    return new Set<string>()
  }

  const left = new Set(parseDrafts(event.newValue).map((draft) => draft.clientId))
  const before = parseDrafts(event.oldValue).map((draft) => draft.clientId)
  return new Set(before.filter((clientId) => !left.has(clientId)))
}

function parseDrafts(value: string | null): CommentDraft[] {
  let stored: unknown
  try {
    stored = JSON.parse(value ?? '[]')
  } catch {
    return []
  }

  if (!Array.isArray(stored)) {
    return []
  }

  return stored.filter(isDraft).map((draft) => ({ ...draft, isSent: draft.isSent === true }))
}

/** Keeps the draft, in place of any earlier one with its client id. */
export function keepDraft(user: string, node: string, draft: CommentDraft) {
  const others = readDrafts(user, node).filter((kept) => kept.clientId !== draft.clientId)
  writeDrafts(user, node, [...others, draft])
}

export function dropDraft(user: string, node: string, clientId: string) {
  const left = readDrafts(user, node).filter((kept) => kept.clientId !== clientId)
  writeDrafts(user, node, left)
}

function writeDrafts(user: string, node: string, drafts: CommentDraft[]) {
  try {
    if (drafts.length) {
      localStorage.setItem(keyOf(user, node), JSON.stringify(drafts))
    } else {
      localStorage.removeItem(keyOf(user, node))
    }
  } catch {
    // Blocked or full storage: the draft lives only in this tab
  }
}

function keyOf(user: string, node: string) {
  return `${PREFIX}${user}:${node}`
}

function isDraft(value: unknown): value is CommentDraft {
  const draft = value as Partial<CommentDraft> | null
  return (
    typeof draft?.clientId === 'string' &&
    typeof draft.anchor === 'string' &&
    typeof draft.text === 'string'
  )
}
