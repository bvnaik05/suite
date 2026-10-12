import * as Y from 'yjs'

import { classifyRefusal, type AccessRoom } from './access'
import { readReply, type Reply } from './answers'
import { backoffMs } from './backoff'
import { encodePush, type PushHeader } from './frames'
import type { Live } from './live'
import {
  KEEPALIVE_QUOTA,
  MAX_HEADER_BYTES,
  MAX_KEEPALIVE_BYTES,
  MAX_PUSH_BYTES,
  type Outbox,
} from './outbox'
import { PIECE_BYTES, putPieces, stageFor, type Staging } from './pieces'
import { isRecoverable, type Held, type SaveState } from './types'
import type { SuspectReport } from './verdict'

/** What sending this tab's work reads and changes on the room. */
export interface SenderRoom extends AccessRoom {
  readonly lineage: string
  readonly bound: boolean
  readonly closed: boolean
  readonly held: Held | null
  readonly appliedThrough: number
  readonly saveState: SaveState
  readonly ownOutbox: Outbox
  readonly outboxes: readonly Outbox[]
  readonly realtime: Pick<Live, 'live' | 'pushed' | 'pullHoleLater'> | null
  readonly suspect: Pick<SuspectReport, 'isJudging'>
  pull(): Promise<void>
  acknowledge(box: Outbox, through: number): void
  setPaused(reason: string | null): void
  setHeld(held: Held | null): void
  markNeedsRebuild(): void
  stopForGood(reason: string): Promise<void>
  onServerHeard(): void
  onUnreachable(): void
}

// The gap between pushes until the server names its own
const DEFAULT_PACE_MS = 500
const MAX_PACE_MS = 10_000

// The seqs of one session a push carries, through `to`
type PushRange = { box: Outbox; to: number }
// A keepalive push ready to send, with the seqs it carries
type KeepalivePush = { header: { from: number; to: number }; body: Uint8Array<ArrayBuffer> }

// A server pace that is missing or not a number falls back to the default; one out of range is held to it
function paceWithinRange(paceMs: unknown) {
  if (typeof paceMs !== 'number' || !Number.isFinite(paceMs)) {
    return DEFAULT_PACE_MS
  }

  return Math.min(Math.max(paceMs, 0), MAX_PACE_MS)
}

// Pushes the room's unsent work one push at a time, at the server's pace, and settles each answer
export class Sender {
  inFlight: Promise<void> | null = null
  retrying: Promise<void> | null = null
  private inFlightRange: PushRange | null = null
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private paceMs = DEFAULT_PACE_MS
  private lastPushStartedAt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private endRetry: (() => void) | null = null
  private staging: Staging | null = null

  constructor(private readonly room: SenderRoom) {}

  // A hidden or departing page may never run its send timer, its retry, or hear back from a save on its way
  sendNow = () => {
    this.cancelQueuedSend()
    // The push on its way may have landed unanswered, which only what follows it continues,
    // or never reached the server, which only all of it covers
    if (this.inFlight) {
      this.sendKeepalivePair()
      return
    }

    this.endRetry?.()
    void this.send({ keepalive: true })
  }

  // The first edit after a quiet spell goes out at once; later ones wait out the server's pace and go together
  scheduleSend() {
    if (this.sendTimer) return

    const paceEndsAt = this.lastPushStartedAt + this.paceMs
    const wait = Math.max(0, paceEndsAt - Date.now())
    const sendQueued = () => {
      this.sendTimer = null
      void this.send()
    }
    this.sendTimer = setTimeout(sendQueued, wait)
  }

  // Typing already waiting goes out by the new pace
  setPace(paceMs: unknown) {
    this.paceMs = paceWithinRange(paceMs)
    if (this.sendTimer) {
      this.cancelQueuedSend()
      this.scheduleSend()
    }
  }

  // A retry waiting out its delay goes now
  retryNow() {
    if (!this.retrying) return

    this.endRetry?.()
    void this.send()
  }

  clearTimers() {
    this.cancelQueuedSend()
    this.endRetry?.()
  }

  send(request: { keepalive?: boolean } = {}): Promise<void> {
    if (this.inFlight || this.retrying) {
      return this.inFlight ?? this.retrying!
    }

    const prepared = this.preparePush(request.keepalive)
    if (!prepared) {
      return Promise.resolve()
    }

    // What was queued goes in this push
    this.cancelQueuedSend()
    this.lastPushStartedAt = Date.now()

    const { box, header, body, pieces } = prepared
    const { endpoints } = this.room.options
    const push = async () => {
      if (pieces) {
        const refused = await putPieces(endpoints, pieces.stage, header, pieces.update)
        if (refused) {
          return refused
        }
      }

      const pushOptions = pieces ? {} : request
      const answer = await endpoints.push(body, pushOptions)
      return readReply(answer)
    }
    const pushFailed = () => {
      this.room.onUnreachable()
      this.retryAfter(backoffMs())
    }
    const pushDone = () => {
      this.inFlight = null
      this.inFlightRange = null
      this.room.notifyListeners()
    }
    this.inFlightRange = { box, to: header.to }
    this.inFlight = Promise.resolve()
      .then(push)
      .then((reply) => this.settlePush(reply, box, header.to), pushFailed)
      .finally(pushDone)
    this.room.notifyListeners()
    return this.inFlight
  }

  // Both are in flight at once, so they share the browser's keepalive quota
  private sendKeepalivePair() {
    const pending = this.inFlightRange?.box.pending ?? []
    const lastUnsent = pending[pending.length - 1]?.seq
    const overlapAlone = this.keepalivePush(null, KEEPALIVE_QUOTA)
    // The server stores only what it lacks, so an overlap that carries all the unsent work goes alone
    if (overlapAlone && overlapAlone.header.to === lastUnsent) {
      this.sendKeepalive(overlapAlone.body)
      return
    }

    const tail = this.keepalivePush(this.inFlightRange, KEEPALIVE_QUOTA / 2)
    const overlap = this.keepalivePush(null, KEEPALIVE_QUOTA - (tail?.body.byteLength ?? 0))
    if (tail && overlap) {
      this.sendKeepalive(tail.body)
      this.sendKeepalive(overlap.body)
      return
    }

    // When only one fits, the overlap holds the most
    const alone = overlapAlone ?? this.keepalivePush(this.inFlightRange, KEEPALIVE_QUOTA)
    if (alone) {
      this.sendKeepalive(alone.body)
    }
  }

  private sendKeepalive(body: Uint8Array<ArrayBuffer>) {
    void this.room.options.endpoints.push(body, { keepalive: true }).catch(() => {})
  }

  // Null when there is nothing to send or not even one entry fits in `quota`
  private keepalivePush(
    after: PushRange | null,
    quota: number,
    maxBytes = quota - MAX_HEADER_BYTES,
  ): KeepalivePush | null {
    const prepared = this.preparePush(true, after, maxBytes)
    if (!prepared || prepared.pieces) {
      return null
    }

    const overshoot = prepared.body.byteLength - quota
    if (overshoot <= 0) {
      return prepared
    }

    if (prepared.header.from === prepared.header.to) {
      return null
    }

    // The header can outgrow its allowance, so fewer entries may fit
    return this.keepalivePush(after, quota, maxBytes - overshoot)
  }

  private cancelQueuedSend() {
    if (this.sendTimer) {
      clearTimeout(this.sendTimer)
    }
    this.sendTimer = null
  }

  private preparePush(
    keepalive?: boolean,
    after: PushRange | null = null,
    maxBytes = keepalive ? MAX_KEEPALIVE_BYTES : MAX_PUSH_BYTES,
  ) {
    const room = this.room
    const box = after?.box ?? room.outboxes.find((other) => other.pending.length) ?? room.ownOutbox
    const cannotSend =
      room.closed || !room.bound || room.suspect.isJudging || room.saveState === 'failed'
    if (!box.pending.length || cannotSend) {
      return null
    }

    const entries = box.nextBatch(maxBytes, after?.to)
    if (!entries.length) {
      return null
    }

    const header: PushHeader = {
      proto: 1,
      lineage: room.lineage,
      principal: room.options.principal,
      schema: room.options.adapter.features.schema,
      sid: box.sid,
      from: entries[0].seq,
      to: entries[entries.length - 1].seq,
      cid: box.cid,
      seen_rev: room.appliedThrough,
      shas: entries.map((entry) => entry.sha),
      final: !!keepalive,
    }
    const batchUpdates = entries.map((entry) => entry.bytes)
    const update = Y.mergeUpdates(batchUpdates)
    if (update.byteLength <= PIECE_BYTES) {
      const body = encodePush(header, update)
      return { box, header, body }
    }

    // Staged pieces take several requests, which a departing page can't count on
    this.staging = stageFor(this.staging, header)
    const staged: PushHeader = {
      ...header,
      final: false,
      stage_id: this.staging.id,
    }
    const pieces = {
      stage: this.staging.id,
      update,
    }
    const body = encodePush(staged, new Uint8Array())
    return {
      box,
      header: staged,
      body,
      pieces,
    }
  }

  private async settlePush(reply: Reply, box: Outbox, lastSeq: number) {
    const room = this.room
    if (reply.pace_ms !== undefined) {
      this.setPace(reply.pace_ms)
    }
    if (reply.status !== 423) {
      room.setPaused(null)
    }
    if (reply.status === 200) {
      this.onCommitted(reply, box, lastSeq)
      return
    }

    if (reply.status === 409 && reply.collab === 'seq' && typeof reply.acked === 'number') {
      // The server lost seqs it already acknowledged, so resending can't restore them
      if (reply.acked < box.acked) {
        return room.stopForGood('seq')
      }

      room.acknowledge(box, reply.acked)
      if (box.hasGap) {
        return room.stopForGood('seq')
      }

      return this.retryAfter(0)
    }

    // Pieces the server dropped or never got are staged again; a stage it refused is replaced
    const stageFailed = reply.collab === 'stage_conflict' || reply.collab === 'stage_incomplete'
    if (reply.status === 409 && stageFailed) {
      if (reply.collab === 'stage_conflict') {
        this.staging = null
      }
      return this.retryAfter(backoffMs())
    }

    // A change that adds content to a full document is never taken, so it waits in a recovery copy
    if (reply.status === 423 && reply.collab === 'doc_full') {
      await room.stopForGood('document_full')
      return room.markNeedsRebuild()
    }

    if (reply.status === 423) {
      if (reply.reason === 'suspect') {
        room.setHeld(room.held ?? 'change')
      }
      room.setPaused(reply.reason ?? reply.collab ?? 'busy')
      return this.retryAfter(reply.retry_ms ?? 1000)
    }

    const blocked = classifyRefusal(room, reply, 'lost_edit')
    if (blocked && isRecoverable(blocked)) {
      return this.retryAfter(backoffMs())
    }

    if (blocked) return

    if (!reply.collab) {
      // Only a proxy refuses a body without a reason; the change stays here until uploads get through
      if (reply.status === 413) {
        room.setPaused('upload_refused')
      }
      return this.retryAfter(backoffMs())
    }

    await room.stopForGood(reply.collab)
    // The server quarantined a change of this session, which this copy still holds
    if (reply.collab === 'client_closed') {
      room.markNeedsRebuild()
    }
  }

  private onCommitted(reply: Reply, box: Outbox, lastSeq: number) {
    const room = this.room
    room.onServerHeard()
    const ackedThrough = reply.dup ? (reply.acked ?? lastSeq) : lastSeq
    room.acknowledge(box, ackedThrough)
    if (!reply.dup && typeof reply.rev === 'number') {
      room.realtime?.pushed(reply.rev)
    }

    const head = reply.head ?? 0
    const rowsAhead = head > room.appliedThrough
    // Live, the rows come over the socket; one still missing in a second is pulled
    if (rowsAhead && room.realtime?.live) {
      room.realtime.pullHoleLater(() => room.appliedThrough < head)
    } else if (rowsAhead) {
      void room.pull()
    }
    if (room.unsent) {
      this.scheduleSend()
    }
  }

  private retryAfter(delayMs: number) {
    if (this.room.closed) return

    this.endRetry?.()
    const waitForRetry = (resolve: () => void) => {
      this.endRetry = () => {
        if (this.retryTimer) {
          clearTimeout(this.retryTimer)
        }
        this.retryTimer = null
        this.retrying = null
        this.endRetry = null
        resolve()
      }

      this.retryTimer = setTimeout(() => this.retryNow(), delayMs)
    }
    this.retrying = new Promise<void>(waitForRetry)
  }
}
