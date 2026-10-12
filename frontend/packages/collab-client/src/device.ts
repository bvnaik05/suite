import type { DeviceCopy, DeviceStore, StoredEntry, StoredSession } from './store'
import type { DeviceDoc } from './types'

// One document in the device store. A write that fails is let go: the room carries on from what it holds in memory
export class Device {
  readonly store: DeviceStore
  readonly doc: string
  // Tells this document's other tabs on the device that its stored work changed; a hint, as each tab reads the store
  private notices: BroadcastChannel | null = null

  constructor({ store, doc }: DeviceDoc) {
    this.store = store
    this.doc = doc
    if (globalThis.BroadcastChannel) {
      this.notices = new BroadcastChannel(`suite-collab:${doc}`)
    }
  }

  sessions(): Promise<StoredSession[]> {
    return this.store.sessions(this.doc).catch(() => [])
  }

  entries(sid: string): Promise<StoredEntry[]> {
    return this.store.entries(this.doc, sid).catch(() => [])
  }

  saveSession(session: StoredSession): Promise<void> {
    return this.store.saveSession(session).catch(() => {})
  }

  async acknowledge(
    sid: string,
    through: number,
    bytes: Uint8Array,
    lineage: string,
    epoch: number,
  ) {
    const acknowledged = this.store.acknowledge(this.doc, sid, through, bytes, lineage, epoch)
    await acknowledged.catch(() => {})
    this.changed()
  }

  commit(copy: Omit<DeviceCopy, 'bytes'>, bytes: Uint8Array | null): Promise<void> {
    return this.store.commit(this.doc, copy, bytes).catch(() => {})
  }

  async recover(sid: string, reason: string, extra?: StoredEntry[]) {
    await this.store.recover(this.doc, sid, reason, extra).catch(() => {})
    this.changed()
  }

  async release(sid: string) {
    await this.store.release(this.doc, sid).catch(() => {})
    this.changed()
  }

  // Entries the sessions not in `held` keep on the device, which their tabs have yet to see committed
  async othersUnsent(held: string[]) {
    const sessions = await this.sessions()
    const others = sessions.filter((session) => !held.includes(session.sid))
    const counts = await Promise.all(
      others.map(async (session) => (await this.entries(session.sid)).length),
    )
    return counts.reduce((sum, count) => sum + count, 0)
  }

  changed() {
    this.notices?.postMessage(null)
  }

  onChanged(listener: () => void) {
    if (this.notices) {
      this.notices.onmessage = listener
    }
  }

  close() {
    this.notices?.close()
    this.notices = null
  }
}
