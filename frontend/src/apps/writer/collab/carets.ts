import type { RoomPresence } from '@suite/collab-client'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { relativePositionToAbsolutePosition, yCursorPlugin, ySyncPluginKey } from '@tiptap/y-tiptap'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'

import { peerName, whenNamed } from './peers'

type CaretUser = { id: string; color: string }

// Whether a peer's position points at text this tab has
function canPlace(editor: Editor, position: unknown) {
  const syncState = ySyncPluginKey.getState(editor.state)
  if (!syncState?.binding) {
    return false
  }

  const relative = Y.createRelativePositionFromJSON(position)
  const absolute = relativePositionToAbsolutePosition(
    syncState.doc,
    syncState.type,
    relative,
    syncState.binding.mapping,
    syncState.binding.hidden,
  )
  return absolute !== null
}

function caretDrawer(labelFader: NameFader) {
  return (user: CaretUser, peerId: number) => {
    const caret = document.createElement('span')
    caret.classList.add('collaboration-carets__caret')
    caret.style.borderColor = user.color

    const label = document.createElement('div')
    label.classList.add('collaboration-carets__label')
    label.style.backgroundColor = user.color
    label.textContent = peerName(user.id, peerId)
    labelFader.track(peerId, label)

    // The plugin keeps a caret's element while the pid stays, so a name that arrives later is filled in
    whenNamed(user.id, () => (label.textContent = peerName(user.id, peerId)))

    caret.append(label)
    return caret
  }
}

const shadeSelection = (user: { color: string }) => ({
  class: 'collaboration-carets__selection',
  style: `background-color: ${user.color}${SHADE_ALPHA}`,
})

// Other people's carets, drawn from the room's presence. This tab's own state is client 0, which the
// default filter would draw because it compares against the document's clientID
export const Carets = Extension.create<{ presence: RoomPresence | null }>({
  name: 'collabCarets',
  addOptions: () => ({ presence: null }),
  addProseMirrorPlugins() {
    if (!this.options.presence) {
      return []
    }

    const editor = this.editor
    const awareness = this.options.presence.awareness
    const labelFader = nameFader(awareness)
    const cursorOptions = {
      awarenessStateFilter: (_: number, id: number) => id !== 0,
      cursorBuilder: caretDrawer(labelFader),
      selectionBuilder: shadeSelection,
    }

    const placedAwareness = withHeldCarets(awareness, (position) => canPlace(editor, position))
    // The plugin reads only the members a held awareness has
    return [
      yCursorPlugin(placedAwareness as Awareness, cursorOptions),
      new Plugin({ view: () => ({ destroy: labelFader.destroy }) }),
    ]
  },
})

// Alpha appended to a peer's #rrggbb colour, light enough to read the text through two overlapping shades
const SHADE_ALPHA = '33'
const NAME_SHOWN_MS = 3000

type NameFader = ReturnType<typeof nameFader>

// A caret's name shows while its peer moves or types, and fades once they have been still a while
function nameFader(awareness: Awareness) {
  const labels = new Map<number, HTMLElement>()
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  const lastCarets = new Map<number, string>()

  const setLabelIdle = (peerId: number, isIdle: boolean) =>
    labels.get(peerId)?.classList.toggle('collaboration-carets__label--idle', isIdle)

  const forgetPeer = (peerId: number) => {
    clearTimeout(timers.get(peerId))
    for (const map of [labels, timers, lastCarets]) {
      map.delete(peerId)
    }
  }

  const onAwarenessChange = ({ added, updated, removed }: Record<string, number[]>) => {
    removed.forEach(forgetPeer)
    for (const peerId of [...added, ...updated]) {
      const cursor = awareness.getStates().get(peerId)?.cursor ?? null
      const caretJson = JSON.stringify(cursor)
      if (lastCarets.get(peerId) === caretJson) continue

      lastCarets.set(peerId, caretJson)
      setLabelIdle(peerId, false)
      clearTimeout(timers.get(peerId))

      const fade = () => {
        timers.delete(peerId)
        setLabelIdle(peerId, true)
      }
      timers.set(peerId, setTimeout(fade, NAME_SHOWN_MS))
    }
  }

  awareness.on('change', onAwarenessChange)
  return {
    track(peerId: number, label: HTMLElement) {
      labels.set(peerId, label)
      setLabelIdle(peerId, lastCarets.has(peerId) && !timers.has(peerId))
    },
    destroy() {
      awareness.off('change', onAwarenessChange)
      for (const peerId of [...timers.keys()]) {
        forgetPeer(peerId)
      }
    },
  }
}

type Caret = { anchor: unknown; head: unknown }

// The members of an awareness the cursor plugin uses
type HeldAwareness = Pick<
  Awareness,
  'getStates' | 'getLocalState' | 'setLocalStateField' | 'on' | 'off'
>

// A peer's caret can point into text whose row hasn't reached this tab, and the plugin draws no caret it can't
// place. Until it can, the caret stays where it last was placed, which this tab's own edits keep valid
function withHeldCarets(
  awareness: Awareness,
  canPlace: (position: unknown) => boolean,
): HeldAwareness {
  const heldCarets = new Map<number, Caret>()
  return {
    getStates() {
      const states = awareness.getStates()
      for (const id of heldCarets.keys()) {
        if (!states.get(id)?.cursor) {
          heldCarets.delete(id)
        }
      }

      const shownStates = new Map<number, Record<string, unknown>>()
      for (const [id, state] of states) {
        const cursor = state.cursor as Caret | null | undefined
        if (cursor && canPlace(cursor.anchor) && canPlace(cursor.head)) {
          heldCarets.set(id, cursor)
        }

        const shownState = heldCarets.has(id) ? { ...state, cursor: heldCarets.get(id) } : state
        shownStates.set(id, shownState)
      }
      return shownStates
    },
    getLocalState: () => awareness.getLocalState(),
    setLocalStateField: (field, value) => awareness.setLocalStateField(field, value),
    on: (event, listener) => awareness.on(event, listener),
    off: (event, listener) => awareness.off(event, listener),
  }
}

type CaretRange = { anchor?: unknown; head?: unknown }

type ItemId = { client?: unknown; clock?: unknown }

// A peer's caret as Writer draws it: only the numbers a relative position needs reach the cursor plugin
export function caretPosition(cursor: unknown) {
  const { anchor: rawAnchor, head: rawHead } = (cursor ?? {}) as CaretRange
  const anchor = sanitizePosition(rawAnchor)
  const head = sanitizePosition(rawHead)
  if (!anchor || !head) {
    return null
  }

  return {
    anchor,
    head,
  }
}

function sanitizePosition(raw: unknown) {
  const { type, tname, item, assoc } = (raw ?? {}) as Record<string, unknown>
  const itemId = sanitizeItemId(item)
  const typeId = sanitizeItemId(type)
  if (itemId === undefined || typeId === undefined) {
    return null
  }

  const strayName = tname !== undefined && tname !== null && typeof tname !== 'string'
  if (strayName) {
    return null
  }

  // No item, no parent type and no root type name leaves nothing to anchor to
  const unanchored = !itemId && !typeId && typeof tname !== 'string'
  if (unanchored) {
    return null
  }

  return {
    type: typeId,
    tname: tname ?? null,
    item: itemId,
    assoc: typeof assoc === 'number' ? assoc : 0,
  }
}

function sanitizeItemId(raw: unknown) {
  if (raw === null || raw === undefined) {
    return null
  }

  const { client, clock } = raw as ItemId
  if (!Number.isInteger(client) || !Number.isInteger(clock)) {
    return undefined
  }

  return { client, clock }
}
