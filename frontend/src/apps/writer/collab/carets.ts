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

// A flag carries a signed-in person's first name; a guest keeps the whole label, which tells guests apart
function flagName(user: string, peerId: number) {
  const name = peerName(user, peerId)
  if (user === 'Guest') {
    return name
  }

  const [firstName] = name.split(' ')
  return firstName
}

function caretDrawer(flags: NameFlags, colourOf: ColourOf) {
  return (user: CaretUser, peerId: number) => {
    const caret = document.createElement('span')
    caret.classList.add('collaboration-carets__caret', 'peer-colour')
    caret.classList.toggle(QUIET, !flags.isNamed(peerId))
    caret.dataset.peer = String(peerId)
    paint(caret, colourOf(peerId))

    const label = document.createElement('div')
    label.classList.add('collaboration-carets__label')
    label.textContent = flagName(user.id, peerId)

    // The plugin keeps a caret's element while the pid stays, so a name that arrives later is filled in
    whenNamed(user.id, () => {
      label.textContent = flagName(user.id, peerId)
    })

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
  // Typing leaves a caret's stored position where it was, so this tab counts its edits for other tabs to see
  onTransaction({ transaction }) {
    const presence = this.options.presence
    const sync = transaction.getMeta(ySyncPluginKey)
    const isOwnEdit = !sync?.isChangeOrigin || sync.isUndoRedoOperation
    if (!presence || !transaction.docChanged || !isOwnEdit || !this.editor.view.hasFocus()) return

    const typed = Number(presence.awareness.getLocalState()?.typed ?? 0)
    presence.awareness.setLocalStateField('typed', typed + 1)
  },
  addProseMirrorPlugins() {
    if (!this.options.presence) {
      return []
    }

    const editor = this.editor
    const presence = this.options.presence
    const awareness = presence.awareness
    const flags = new NameFlags(awareness)
    function colourOf(peerId: number) {
      return presenceColours(presence).get(peerId)
    }

    const cursorOptions = {
      awarenessStateFilter: (_: number, id: number) => id !== 0,
      cursorBuilder: caretDrawer(flags, colourOf),
      selectionBuilder: selectionShader(colourOf),
    }

    const placedAwareness = withHeldCarets(awareness, (position) => canPlace(editor, position))
    // The plugin reads only the members a held awareness has
    return [
      yCursorPlugin(placedAwareness as Awareness, cursorOptions),
      new Plugin({
        view(view) {
          const stopListening = presence.onChange(() => repaint(view, colourOf))
          flags.showIn(view)
          return {
            update: () => flags.settle(),
            destroy() {
              stopListening()
              flags.destroy()
            },
          }
        },
      }),
    ]
  },
})

const NAME_SHOWN_MS = 2000
const QUIET = 'collaboration-carets__caret--quiet'

type Box = ReturnType<EditorView['coordsAtPos']>

// Where this tab's own caret is drawn, while it shows
function ownCaretBox(view: EditorView) {
  if (!view.hasFocus()) {
    return null
  }

  return view.coordsAtPos(view.state.selection.head)
}

// Whether a caret's flag would sit over this tab's own caret
function isOverOwnCaret(caret: HTMLElement, own: Box | null) {
  const label = caret.querySelector('.collaboration-carets__label')
  if (!own || !label) {
    return false
  }

  const flag = label.getBoundingClientRect()
  const isWithin = own.left >= flag.left && own.left <= flag.right
  return isWithin && own.top < flag.bottom && own.bottom > flag.top
}

// A caret's flag names its peer while they act and for two seconds after, then shrinks to a dot; it gives
// way at once when it would sit over this tab's own caret. Hovering a caret brings its name back, in CSS
class NameFlags {
  private actions = new Map<number, string>()
  private timers = new Map<number, ReturnType<typeof setTimeout>>()
  private shownIn: EditorView | null = null

  constructor(private readonly awareness: Awareness) {
    awareness.on('change', this.onAwarenessChange)
  }

  isNamed(peerId: number) {
    return this.timers.has(peerId)
  }

  showIn(view: EditorView) {
    this.shownIn = view
  }

  settle() {
    const view = this.shownIn
    if (!view || view.isDestroyed) return

    const ownCaret = ownCaretBox(view)
    const carets = view.dom.querySelectorAll<HTMLElement>('.collaboration-carets__caret')
    for (const caret of carets) {
      const isNamed = this.isNamed(Number(caret.dataset.peer)) && !isOverOwnCaret(caret, ownCaret)
      caret.classList.toggle(QUIET, !isNamed)
    }
  }

  destroy() {
    this.awareness.off('change', this.onAwarenessChange)
    for (const peerId of [...this.timers.keys()]) {
      this.forget(peerId)
    }
  }

  private forget(peerId: number) {
    clearTimeout(this.timers.get(peerId))
    this.timers.delete(peerId)
    this.actions.delete(peerId)
  }

  private quieten(peerId: number) {
    this.timers.delete(peerId)
    this.settle()
  }

  // A peer acts when their caret, selection or typing count changes, not when their state is only renewed
  private onAwarenessChange = ({ added, updated, removed }: Record<string, number[]>) => {
    for (const peerId of removed) {
      this.forget(peerId)
    }

    const peerIds = [...added, ...updated].filter((peerId) => peerId !== this.awareness.clientID)
    for (const peerId of peerIds) {
      const { cursor = null, typed = null } = this.awareness.getStates().get(peerId) ?? {}
      const action = JSON.stringify([cursor, typed])
      if (this.actions.get(peerId) === action) continue

      this.actions.set(peerId, action)
      clearTimeout(this.timers.get(peerId))
      this.timers.set(
        peerId,
        setTimeout(() => this.quieten(peerId), NAME_SHOWN_MS),
      )
    }

    this.settle()
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
