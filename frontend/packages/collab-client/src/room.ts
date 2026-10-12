import * as Y from 'yjs'

import { block } from './access'
import { Device } from './device'
import type { Limits } from './frames'
import { adoptLeftovers, claimClientId, lostReason } from './leftovers'
import { Live, type LiveHooks } from './live'
import { holdLock } from './locks'
import type { Opening, RoomInit } from './opening'
import { ADOPT, REMOTE } from './origins'
import { Outbox } from './outbox'
import { Puller } from './puller'
import { Sender } from './sender'
import type { StoredSession } from './store'
import {
  isRecoverable,
  type Blocked,
  type CollabRoom,
  type LiveState,
  type OpenOptions,
  type SaveState,
} from './types'
import { SuspectReport } from './verdict'

const PERSIST_AFTER_MS = 60_000
// Without live updates a tab pulls every tick while others are editing or work waits, and every sixth tick otherwise
const QUIET_TICKS = 6
const CO_EDITING_MS = 60_000

// The collaborators below read and change this state directly
export class Room implements CollabRoom {
  readonly doc: Y.Doc
  blocked: Blocked | null = null
  paused: string | null = null
  held: string | null = null
  newerSchema = false
  appliedThrough = 0
  limits: Limits | null = null
  needsRebuild = false
  readonly lineage: string
  readonly epoch: number
  writable: boolean
  bound: boolean
  readonly ownOutbox: Outbox
  // Tabs' leftovers come first and this tab's own stays last
  outboxes: Outbox[]
  closed = false
  // Set once this tab's work can never be committed; the reason it was kept as a recovery copy
  stopReason: string | null = null
  failed = false
  unheard = false
  device: Device | null
  realtime: Live | null = null
  readonly sender = new Sender(this)
  readonly puller = new Puller(this)
  readonly suspect = new SuspectReport(this)
  private connecting: Promise<void> | null = null
  private unsentSince = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<() => void>()
  private persisted = false
  private ticks = 0
  private lastRemoteAt = 0

  constructor(
    init: RoomInit,
    readonly options: OpenOptions,
  ) {
    this.doc = init.doc
    this.lineage = init.lineage
    this.epoch = init.epoch
    this.writable = init.canWrite
    this.bound = init.bound
    this.device = options.device ? new Device(options.device) : null
    this.ownOutbox = new Outbox(init.sid, init.doc.clientID, () => {})
    this.outboxes = [this.ownOutbox]
  }

  async start(opening: Opening) {
    this.doc.on('update', this.onDocUpdate)
    if (this.device && this.writable && this.bound) {
      const session = this.ownSession(this.device)
      await this.device.store.saveSession(session).catch(() => this.dropDeviceStore())
    }

    const ownLockName = this.lockName(this.ownOutbox.sid)
    const releaseOwnLock = await holdLock(ownLockName)
    this.ownOutbox.release = releaseOwnLock ?? (() => {})

    this.appliedThrough = opening.base
    this.sender.setPace(opening.paceMs)
    this.unheard = !!opening.offline
    this.limits = opening.limits ?? null
    this.follow(opening.schema)
    this.puller.applyRows(opening.rows, opening)
    if (this.writable) {
      await adoptLeftovers(this)
    }

    if (this.options.socket && !this.closed) {
      const liveHooks: LiveHooks = {
        heardRows: this.puller.heardRows,
        pull: () => void this.pull(),
        changed: () => this.notifyListeners(),
        appliedThrough: () => this.appliedThrough,
        showsCaret: () => this.canWrite && this.bound && !this.closed,
        position: this.options.adapter.position,
      }
      this.realtime = new Live(this.options.socket, this.lineage, liveHooks)
      if (opening.rooms) {
        this.realtime.setRoomKeys(opening.rooms)
      }
    }

    this.pollTimer = setInterval(() => void this.tick(), this.options.pollMs ?? 5000)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('pagehide', this.sender.sendNow)
  }

  get canWrite() {
    return this.writable && !this.suspect.isJudging && !this.held
  }

  get live(): LiveState | null {
    return this.realtime?.state ?? null
  }

  get presence() {
    return this.realtime?.presence ?? null
  }

  get stopped() {
    return this.stopReason
  }

  get onDevice() {
    return !!this.device
  }

  get atLimit() {
    const limits = this.limits
    if (!limits) {
      return false
    }

    return limits.state_bytes + limits.tail_bound >= limits.state_max
  }

  get unsent() {
    return this.outboxes.reduce((sum, box) => sum + box.pending.length, 0)
  }

  // A stopped tab stays failed while it holds work; once a refusal leaves nothing unsent there is nothing to fail
  get saveState(): SaveState {
    const refusedWithNothingUnsent = !!this.blocked && !this.unsent
    if (this.failed && !refusedWithNothingUnsent) {
      return 'failed'
    }

    if (this.sender.inFlight) {
      return 'saving'
    }

    if (this.unsent) {
      return 'unsaved'
    }

    return 'clean'
  }

  get readBlocked() {
    return this.blocked === 'other_user' || this.blocked === 'lost_read'
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  pull(): Promise<void> {
    if (this.closed || this.needsRebuild || this.readBlocked) {
      return Promise.resolve()
    }

    if (!this.bound) {
      if (this.stopReason) {
        return Promise.resolve()
      }

      return this.claimAndBind()
    }

    return this.connecting ?? this.puller.pullNow()
  }

  // Waits out each retry delay rather than pushing again at once
  async flush() {
    while (this.canFlush) {
      await (this.sender.inFlight ?? this.sender.retrying ?? this.sender.send())
    }
  }

  async close() {
    if (this.closed) return

    if (this.sender.inFlight) {
      await this.sender.inFlight
    }
    if (this.bound && this.unsent && this.saveState !== 'failed') {
      this.clearTimers()
      await this.sender.send({ keepalive: true })
    }

    this.closed = true
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('pagehide', this.sender.sendNow)
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
    }
    this.realtime?.close()
    this.clearTimers()
    this.doc.off('update', this.onDocUpdate)
    this.listeners.clear()
    for (const box of this.outboxes) {
      box.release()
    }
    if (this.device && !this.ownOutbox.pending.length && !this.stopReason) {
      void this.device.release(this.ownOutbox.sid)
    }
  }

  // The work this tab holds can never be committed: keep it as a recovery copy and stop
  async stopForGood(reason: string) {
    this.writable = false
    this.failed = true
    const recovered = this.moveToRecovery(reason)
    this.notifyListeners()
    await recovered
  }

  async moveToRecovery(reason: string) {
    if (this.stopReason) return

    this.stopReason = reason
    if (!this.device) return

    for (const box of this.outboxes) {
      const stored = box.toStoredEntries(this.device.doc)
      await this.device.recover(box.sid, reason, stored)
    }
  }

  // Without a device store nothing typed offline would survive the tab, so editing stops until the server answers
  onUnreachable() {
    this.unheard = true
    if (this.device) {
      if (this.unsent) {
        this.requestPersistentStorage()
      }
    } else if (!this.blocked) {
      block(this, 'offline')
    }
  }

  markNeedsRebuild() {
    if (this.needsRebuild) return

    this.needsRebuild = true
    this.notifyListeners()
  }

  updateLimits(limits: Limits) {
    const wasAtLimit = this.atLimit
    this.limits = limits
    if (this.atLimit !== wasAtLimit) {
      this.notifyListeners()
    }
  }

  setPaused(reason: string | null) {
    if (this.paused === reason) return

    this.paused = reason
    this.notifyListeners()
  }

  // An editor older than the document's rows may drop what it can't show; nothing it does from now on is sent.
  // Work typed before still goes out, as the server takes older schemas
  follow(schema = 0) {
    if (this.newerSchema) {
      return false
    }

    if (schema <= this.options.adapter.features.schema) {
      return true
    }

    this.newerSchema = true
    this.writable = false
    this.notifyListeners()
    return false
  }

  // A held document's pushes wait minutes between tries, so its release sends at once
  setHeld(held: string | null) {
    if (this.held === held) return

    const released = !held
    this.held = held
    this.notifyListeners()
    if (released) {
      this.sender.retryNow()
    }
  }

  // Work held while the server was out of reach goes out on the first answer, not after the retry wait
  onServerHeard() {
    const wasUnheard = this.unheard
    this.unheard = false
    if (this.blocked && !isRecoverable(this.blocked)) return

    const wasBlocked = this.blocked !== null
    if (wasBlocked) {
      this.blocked = null
      this.notifyListeners()
    }
    if (wasBlocked || wasUnheard) {
      this.sender.retryNow()
    }
  }

  acknowledge(box: Outbox, through: number) {
    const committed = box.acknowledge(through)
    if (!committed) return

    if (this.device) {
      void this.device.acknowledge(box.sid, box.acked, committed, this.lineage, this.epoch)
      if (box.adopted && !box.pending.length) {
        void this.device.release(box.sid)
        box.release()
        this.outboxes = this.outboxes.filter((other) => other !== box)
      }
    }
    this.onUnsentChanged()
  }

  onUnsentChanged() {
    if (!this.unsent) {
      this.unsentSince = 0
    } else if (!this.unsentSince) {
      this.unsentSince = Date.now()
    }
    this.notifyListeners()
  }

  lockName(sid: string) {
    return `suite-collab:${this.device?.doc}:${sid}`
  }

  notifyListeners() {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private get canFlush() {
    const hasWork = this.sender.inFlight || this.unsent
    const canSend = this.bound && !this.suspect.isJudging && this.saveState !== 'failed'
    return !this.closed && canSend && !!hasWork
  }

  private tick() {
    const unsentForLong = !!this.unsentSince && Date.now() - this.unsentSince > PERSIST_AFTER_MS
    if (this.unsent && unsentForLong) {
      this.requestPersistentStorage()
    }
    if (this.realtime?.live) return

    this.realtime?.reconnect()
    const coEditing =
      document.visibilityState === 'visible' && Date.now() - this.lastRemoteAt < CO_EDITING_MS
    // Work held while the server is out of reach goes out on the first tick that reaches it
    const hasWorkWaiting = this.unsent || this.unheard || !this.bound
    if (coEditing || hasWorkWaiting || ++this.ticks % QUIET_TICKS === 0) {
      void this.pull()
    }
  }

  // Claim the clientID chosen offline, send what was typed, and only then take anyone else's rows
  private claimAndBind(): Promise<void> {
    const bindAfterClaim = async (answer: string | null) => {
      if (answer === null || this.closed) return

      if (answer !== 'ok') {
        // Other tabs' work never used this clientID, so a later tab can still send it
        for (const box of this.outboxes) {
          if (box.adopted) {
            box.release()
          }
        }
        this.outboxes = [this.ownOutbox]
        const reason = lostReason(answer)
        await this.stopForGood(reason)
        return
      }

      this.bound = true
      this.onServerHeard()
      await adoptLeftovers(this)
      await this.flush()
      await this.puller.pullNow()
    }
    this.connecting ??= claimClientId(this, this.ownOutbox)
      .then(bindAfterClaim)
      .finally(() => (this.connecting = null))
    return this.connecting
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) {
      this.lastRemoteAt = Date.now()
    }
    const fromElsewhere = origin === REMOTE || origin === ADOPT
    if (fromElsewhere || this.closed) return

    // The editor turns read-only a moment after the verdict, so typing can still arrive
    if (this.stopReason) {
      this.recoverLateTyping(update, this.stopReason)
      return
    }

    if (!this.writable) return

    const entry = this.ownOutbox.add(update)
    if (this.device) {
      const session = this.ownSession(this.device)
      const stored = this.ownOutbox.toStoredEntries(this.device.doc, [entry])
      void this.device.store.capture(session, stored).catch(() => this.dropDeviceStore())
    }
    this.onUnsentChanged()
    if (this.bound) {
      this.sender.scheduleSend()
    } else {
      this.requestPersistentStorage()
    }
  }

  private recoverLateTyping(update: Uint8Array, reason: string) {
    if (!this.device) return

    const entry = this.ownOutbox.createEntry(update)
    const stored = this.ownOutbox.toStoredEntries(this.device.doc, [entry])
    void this.device.recover(this.ownOutbox.sid, reason, stored)
  }

  private onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      this.sender.sendNow()
    }
  }

  private dropDeviceStore() {
    if (!this.device) return

    this.device = null
    this.notifyListeners()
  }

  private requestPersistentStorage() {
    if (this.persisted || !this.device) return

    this.persisted = true
    void globalThis.navigator?.storage?.persist?.().catch(() => {})
  }

  private ownSession(device: Device): StoredSession {
    return {
      doc: device.doc,
      sid: this.ownOutbox.sid,
      lineage: this.lineage,
      cid: this.ownOutbox.cid,
      bound: this.bound,
    }
  }

  private clearTimers() {
    this.sender.clearTimers()
    this.suspect.clearTimer()
  }
}
