import * as Y from 'yjs'

import { classifyRefusal } from './access'
import { readReply } from './answers'
import type { Device } from './device'
import { holdLock } from './locks'
import { ADOPT } from './origins'
import { Outbox } from './outbox'
import type { Room } from './room'
import type { StoredEntry } from './store'
import type { Answer, Claim } from './types'

export const lostReason = (verdict: string) => (verdict === 'clash' ? 'id_clash' : verdict)

// Asks the server for a clientID chosen offline. `null` when the claim got no verdict this time; a refusal with a reason is final
export async function claimClientId(room: Room, box: Outbox): Promise<string | null> {
  const claim: Claim = {
    cid: box.cid,
    lineage: room.lineage,
  }
  let answer: Answer
  try {
    answer = await room.options.endpoints.session(box.sid, claim)
  } catch {
    room.onUnreachable()
    return null
  }

  const reply = readReply(answer)
  if (reply.status === 200 && typeof reply.claim === 'string') {
    if (reply.claim === 'ok' && room.device) {
      const session = {
        doc: room.device.doc,
        sid: box.sid,
        lineage: room.lineage,
        cid: box.cid,
        bound: true,
      }
      await room.device.saveSession(session)
    }
    return reply.claim
  }

  const blocked = classifyRefusal(room, reply, 'lost_edit')
  if (blocked) {
    return null
  }

  return reply.collab ?? null
}

// The device copy with the work on top, when the copy is still the history the work was typed on
async function readableState(device: Device, lineage: string, entries: StoredEntry[]) {
  const copy = await device.copy()
  const updates = entries.map((entry) => entry.bytes)
  if (copy?.lineage !== lineage) {
    return Y.mergeUpdates(updates)
  }

  return Y.mergeUpdates([copy.bytes, ...updates])
}

// Unsent work other tabs of this document left on the device, once no live tab holds it
export async function adoptLeftovers(room: Room) {
  const device = room.device
  if (!device || room.stopReason) return

  const sessions = await device.sessions()
  for (const session of sessions) {
    if (room.outboxes.some((box) => box.sid === session.sid)) continue
    if (!session.bound && !room.bound) continue

    const lockName = room.lockName(session.sid)
    const release = await holdLock(lockName)
    if (!release) continue

    if (room.closed) {
      return release()
    }

    const entries = await device.entries(session.sid)
    if (!entries.length) {
      await device.release(session.sid)
      release()
      continue
    }

    const box = new Outbox(session.sid, session.cid, release, true, entries)
    let claimVerdict: string | null = 'ok'
    if (session.lineage !== room.lineage) {
      claimVerdict = 'lineage'
    } else if (!session.bound) {
      claimVerdict = await claimClientId(room, box)
    }
    if (room.closed) {
      return release()
    }

    if (claimVerdict !== 'ok') {
      if (claimVerdict) {
        const reason = lostReason(claimVerdict)
        const state = await readableState(device, session.lineage, entries)
        await device.recover([session.sid], reason, [], state)
      }
      release()
      continue
    }

    const pendingUpdates = box.pending.map((entry) => entry.bytes)
    const adoptedWork = Y.mergeUpdates(pendingUpdates)
    Y.applyUpdate(room.doc, adoptedWork, ADOPT)
    room.outboxes.splice(-1, 0, box)
  }
  room.onUnsentChanged()
  if (room.unsent && room.bound) {
    room.sender.scheduleSend()
  }
}
