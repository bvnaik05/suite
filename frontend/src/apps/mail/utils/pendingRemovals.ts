import { api, client } from '@/api'

/**
 * A permanent removal waiting out its Undo (see commitAfterUndo), written down so it outlives the
 * page. A page closed inside the window cannot send it — the request is a few awaits away from the
 * network, and the page is gone first — so the next start sends what was left.
 */
export type PendingRemoval =
  { kind: 'messages'; names: string[] } | { kind: 'draft'; account: string; id: string }

const KEY = 'suite.mail.pendingRemovals'

type Stored = Record<string, PendingRemoval>

const read = (): Stored => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Stored
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
  write({ ...read(), [key]: removal })
  return key
}

export const forgetRemoval = (key: string) => {
  const { [key]: _forgotten, ...rest } = read()
  write(rest)
}

/**
 * Sends what an earlier page left: its Undo window ended when it closed. A removal the server has
 * already carried out, or refuses, is let go — retrying it on every start would help nobody.
 */
export const resumeRemovals = async (): Promise<boolean> => {
  const left = Object.entries(read())
  for (const [key, removal] of left) {
    await sendRemoval(removal).catch(() => {})
    forgetRemoval(key)
  }
  return left.length > 0
}
