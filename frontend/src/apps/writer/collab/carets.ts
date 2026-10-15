import type { RoomPresence } from '@suite/collab-client'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import {
  relativePositionToAbsolutePosition,
  setMeta,
  yCursorPlugin,
  yCursorPluginKey,
  ySyncPluginKey,
} from '@tiptap/y-tiptap'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'

import { colourStyle, type PeerColour } from './colours'
import { peerName, presenceColours, whenNamed } from './peers'

interface CaretUser {
  id: string
}

type ColourOf = (peerId: number) => PeerColour | undefined

function paint(element: HTMLElement, colour: PeerColour | undefined) {
  if (!colour) return

  for (const [property, value] of Object.entries(colourStyle(colour))) {
    element.style.setProperty(property, value)
  }
}

// The plugin keeps a caret's element while its pid stays, so a colour that moves is painted onto it
function repaint(view: EditorView, colourOf: ColourOf) {
  if (view.isDestroyed) return

  const carets = view.dom.querySelectorAll<HTMLElement>('.collaboration-carets__caret')
  for (const caret of carets) {
    paint(caret, colourOf(Number(caret.dataset.peer)))
  }

  setMeta(view, yCursorPluginKey, { awarenessUpdated: true })
}

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

function caretDrawer(labelFader: NameFader, colourOf: ColourOf) {
  return (user: CaretUser, peerId: number) => {
    const caret = document.createElement('span')
    caret.classList.add('collaboration-carets__caret', 'peer-colour')
    caret.dataset.peer = String(peerId)
    paint(caret, colourOf(peerId))

    const label = document.createElement('div')
    label.classList.add('collaboration-carets__label')
    label.textContent = peerName(user.id, peerId)
    labelFader.track(peerId, label)

    // The plugin keeps a caret's element while the pid stays, so a name that arrives later is filled in
    whenNamed(user.id, () => (label.textContent = peerName(user.id, peerId)))

    caret.append(label)
    return caret
  }
}

// A colour as an inline style, for a decoration that takes its style as text
function styleText(colour: PeerColour | undefined) {
  if (!colour) {
    return ''
  }

  const properties = Object.entries(colourStyle(colour))
  return properties.map(([property, value]) => `${property}: ${value}`).join('; ')
}

function selectionShader(colourOf: ColourOf) {
  return (_: CaretUser, peerId: number) => ({
    class: 'collaboration-carets__selection peer-colour',
    style: styleText(colourOf(peerId)),
  })
}

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
    const presence = this.options.presence
    const awareness = presence.awareness
    const labelFader = nameFader(awareness)
    function colourOf(peerId: number) {
      return presenceColours(presence).get(peerId)
    }

    const cursorOptions = {
      awarenessStateFilter: (_: number, id: number) => id !== 0,
      cursorBuilder: caretDrawer(labelFader, colourOf),
      selectionBuilder: selectionShader(colourOf),
    }

    const placedAwareness = withHeldCarets(awareness, (position) => canPlace(editor, position))
    // The plugin reads only the members a held awareness has
    return [
      yCursorPlugin(placedAwareness as Awareness, cursorOptions),
      new Plugin({
        view(view) {
          const stopListening = presence.onChange(() => repaint(view, colourOf))
          return {
            destroy() {
              stopListening()
              labelFader.destroy()
            },
          }
        },
      }),
    ]
  },
})

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
