import { digest } from 'lib0/hash/sha256'
import * as Y from 'yjs'

import { hex } from './bytes'
import type { StoredEntry } from './store'

// Each sha adds 67 bytes to the push header, which the server caps at 4 KiB
const MAX_ENTRIES = 48
export const MAX_HEADER_BYTES = 4 * 1024
export const MAX_PUSH_BYTES = 256 * 1024
// Browsers refuse keepalive requests past 64 KiB in flight at once; 1 KiB stays for the URL and headers
export const KEEPALIVE_QUOTA = 63 * 1024
export const MAX_KEEPALIVE_BYTES = KEEPALIVE_QUOTA - MAX_HEADER_BYTES

// `sha` lets the server tell a resent seq from a different one under the same number;
// `seenRev` is the rev the tab had applied when it was typed
export interface Entry {
  seq: number
  bytes: Uint8Array
  sha: string
  seenRev: number
}

// One session's unsent work: this tab's own, or one adopted from a tab that closed
export class Outbox {
  pending: Entry[]
  nextSeq: number
  acked: number

  constructor(
    readonly sid: string,
    readonly cid: number,
    public release: () => void,
    readonly adopted = false,
    // What a closed tab left on the device
    stored: StoredEntry[] = [],
  ) {
    this.pending = stored.map(({ seq, bytes, sha, seenRev }) => ({ seq, bytes, sha, seenRev }))
    this.nextSeq = stored.length ? stored[stored.length - 1].seq + 1 : 1
    this.acked = stored.length ? stored[0].seq - 1 : 0
  }

  // The next seq's entry, not yet queued
  createEntry(bytes: Uint8Array, seenRev: number): Entry {
    const sha = hex(digest(bytes))
    return {
      seq: this.nextSeq++,
      bytes,
      sha,
      seenRev,
    }
  }

  add(bytes: Uint8Array, seenRev: number): Entry {
    const entry = this.createEntry(bytes, seenRev)
    this.pending.push(entry)
    return entry
  }

  // The server holds everything up to `through`; returns what that newly committed, merged
  acknowledge(through: number): Uint8Array | null {
    this.acked = Math.max(this.acked, through)
    const committed = this.pending.filter((entry) => entry.seq <= this.acked)
    if (!committed.length) {
      return null
    }

    this.pending = this.pending.filter((entry) => entry.seq > this.acked)
    return Y.mergeUpdates(committed.map((entry) => entry.bytes))
  }

  // Holds work typed before the restore at `restoreRev`
  isStaleAfter(restoreRev: number) {
    return this.pending.some((entry) => entry.seenRev < restoreRev)
  }

  // Pending work no longer continues from what the server acknowledged
  get hasGap() {
    return this.pending.length > 0 && this.pending[0].seq !== this.acked + 1
  }

  // The longest leading run of pending entries after `afterSeq` that fits one push
  nextBatch(maxBytes: number, afterSeq = 0): Entry[] {
    const batch: Entry[] = []
    let size = 0
    const unsent = this.pending.filter((entry) => entry.seq > afterSeq)
    for (const entry of unsent) {
      const tooMany = batch.length >= MAX_ENTRIES
      const tooBig = size + entry.bytes.byteLength > maxBytes
      if (batch.length && (tooMany || tooBig)) {
        break
      }
      batch.push(entry)
      size += entry.bytes.byteLength
    }
    return batch
  }

  toStoredEntries(doc: string, entries: Entry[] = this.pending): StoredEntry[] {
    const withSession = (entry: Entry): StoredEntry => ({
      doc,
      sid: this.sid,
      ...entry,
    })
    return entries.map(withSession)
  }
}
