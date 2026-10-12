import type { DeviceCopy, DeviceStore, StoredEntry, StoredSession } from './store'
import type { DeviceDoc } from './types'

// One document in the device store. A write that fails is let go: the room carries on from what it holds in memory
export class Device {
  readonly store: DeviceStore
  readonly doc: string

  constructor({ store, doc }: DeviceDoc) {
    this.store = store
    this.doc = doc
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

  acknowledge(sid: string, through: number, bytes: Uint8Array, lineage: string, epoch: number) {
    const acknowledged = this.store.acknowledge(this.doc, sid, through, bytes, lineage, epoch)
    return acknowledged.catch(() => {})
  }

  commit(copy: Omit<DeviceCopy, 'bytes'>, bytes: Uint8Array | null): Promise<void> {
    return this.store.commit(this.doc, copy, bytes).catch(() => {})
  }

  recover(sid: string, reason: string, extra?: StoredEntry[]): Promise<void> {
    return this.store.recover(this.doc, sid, reason, extra).catch(() => {})
  }

  release(sid: string): Promise<boolean | void> {
    return this.store.release(this.doc, sid).catch(() => {})
  }
}
