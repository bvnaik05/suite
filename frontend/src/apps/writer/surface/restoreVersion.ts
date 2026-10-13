import type { CollabRoom, RestoreResult } from '@suite/collab-client'

import { restoreEdit } from '@/apps/writer/collab/restore'
import { withinTenSeconds } from '@/apps/writer/collab/timeout'

import { readVersionBody } from './versions'

type RestoringRoom = Pick<CollabRoom, 'doc' | 'lineage' | 'flush' | 'restoreVersion'>

/** What the person is told after a restore: whether the document is the version now, and how it went. */
export interface RestoreNotice {
  isRestored: boolean
  message: string
}

// The server's wait between restores, for a refusal that doesn't say how long is left
const RESTORE_EVERY_SECONDS = 60

const REFUSALS: Record<string, string> = {
  restoring: 'Someone else is restoring a version. Try again once it is done.',
  behind: 'This tab is still catching up. Try again in a moment.',
  milestone_failed:
    "The document as it is now couldn't be kept as a version first, so nothing was restored.",
  paused: 'Saving is paused, so nothing was restored.',
}

/** Restores version `seq` from its stored bytes, after this tab's edits are saved. */
export async function restoreVersion(
  room: RestoringRoom,
  seq: number,
  bytes: Uint8Array,
): Promise<RestoreNotice> {
  let body
  try {
    body = await readVersionBody(bytes)
  } catch {
    return { isRestored: false, message: "This version can't be restored." }
  }

  await withinTenSeconds(room.flush())
  const result = await room.restoreVersion(seq, () => restoreEdit(room.doc, room.lineage, body))
  return noticeFor(result)
}

function noticeFor(result: RestoreResult): RestoreNotice {
  if (result.outcome === 'landed') {
    return { isRestored: true, message: 'Version restored' }
  }

  if (result.outcome === 'unchanged') {
    return { isRestored: true, message: 'The document already matches this version.' }
  }

  if (result.outcome === 'unsent') {
    return { isRestored: false, message: 'Your changes are still saving. Try again in a moment.' }
  }

  if (result.refusal === 'restore_recent') {
    const wait = result.retryS ?? RESTORE_EVERY_SECONDS
    return {
      isRestored: false,
      message: `A restore just ran. Try again in ${wait} seconds.`,
    }
  }

  const message = REFUSALS[result.refusal ?? ''] ?? 'The version was not restored.'
  return { isRestored: false, message }
}
