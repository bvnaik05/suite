import { api, client } from '@/api'

/**
 * A permanent removal waiting out its Undo (see commitAfterUndo), written down so it outlives the
 * page. A page closed inside the window cannot send it — the request is a few awaits away from the
 * network, and the page is gone first — so the next start sends what was left.
 */
export type PendingRemoval =
  { kind: 'messages'; names: string[] } | { kind: 'draft'; account: string; id: string }

const KEY = 'suite.mail.pendingRemovals'

// How long after it is written a removal counts as abandoned rather than still inside a live tab's
// Undo window. Longer than the toast, with room to spare.
const UNDO_WINDOW_MS = 15_000

// `due`: when the removal stops being anyone's to undo. Before then another tab may still be
// offering Undo on it, and only that tab can send it.
type Stored = Record<string, { removal: PendingRemoval; due: number }>

const read = (): Stored => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, unknown>
    // An entry written before removals carried a due time is the removal itself: long overdue.
    return Object.fromEntries(
      Object.entries(raw).map(([key, entry]) => [
        key,
        entry && typeof entry === 'object' && 'kind' in entry
          ? { removal: entry as PendingRemoval, due: 0 }
          : (entry as Stored[string]),
      ]),
    )
  } catch {
    return {}
  }
}
const write = (stored: Stored) => {
  try {
    if (Object.keys(stored).length) localStorage.setItem(KEY, JSON.stringify(stored))
    else localStorage.removeItem(KEY)
  } catch {
    // Without storage the removal only lives as long as the page, as before.
  }
}

export const sendRemoval = (removal: PendingRemoval): Promise<unknown> => {
  if (removal.kind === 'draft')
    return client.mutation(api.mail.messages.deleteDraft, {
      account: removal.account,
      id: removal.id,
    })
  // Nothing on the server to remove — a draft never saved.
  if (!removal.names.length) return Promise.resolve()
  return client.mutation(api.mail.messages.delete, { names: removal.names })
}

/** Writes the removal down; returns the key to forget it by. */
export const rememberRemoval = (removal: PendingRemoval): string => {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  write({ ...read(), [key]: { removal, due: Date.now() + UNDO_WINDOW_MS } })
  return key
}

export const forgetRemoval = (key: string) => {
  const { [key]: _forgotten, ...rest } = read()
  write(rest)
}

/**
 * Sends what a closed page left once its Undo window is over. One not yet due may belong to another
 * tab still offering Undo on it, so it is looked at again when due: by then that tab has sent or
 * forgotten it, and whatever is still here was abandoned. A removal the server has already carried
 * out, or refuses, is let go — retrying it on every start would help nobody.
 */
export const resumeRemovals = async (onSent?: () => void): Promise<void> => {
  const now = Date.now()
  const entries = Object.entries(read())
  const due = entries.filter(([, entry]) => entry.due <= now)
  for (const [key, entry] of due) {
    forgetRemoval(key)
    await sendRemoval(entry.removal).catch(() => {})
  }
  if (due.length) onSent?.()
  const next = Math.min(...entries.filter(([, entry]) => entry.due > now).map(([, e]) => e.due))
  if (Number.isFinite(next)) setTimeout(() => void resumeRemovals(onSent), next - now + 50)
}
