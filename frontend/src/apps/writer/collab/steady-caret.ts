import { Extension } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey } from '@tiptap/y-tiptap'

interface Storage {
  scroller: HTMLElement | null
  caretTop: number | null
  isDragging: boolean
  stop: (() => void) | null
}

function isOthersEdit(transaction: Transaction) {
  const sync = transaction.getMeta(ySyncPluginKey)
  return transaction.docChanged && !!sync?.isChangeOrigin && !sync.isUndoRedoOperation
}

// A sideways scroller reads as overflow-y auto too, so only one with content below its fold counts
function isScrollingDown(element: HTMLElement) {
  const isScrollable = /auto|scroll/.test(getComputedStyle(element).overflowY)
  return isScrollable && element.scrollHeight > element.clientHeight
}

function scrollerOf(element: HTMLElement) {
  let parent = element.parentElement
  while (parent && !isScrollingDown(parent)) {
    parent = parent.parentElement
  }

  return parent
}

function caretTop(view: EditorView) {
  return view.coordsAtPos(view.state.selection.head).top
}

// Where this tab's caret sits on screen before others' edit lands, while it is in sight
function measure(storage: Storage, view: EditorView, transaction: Transaction) {
  storage.caretTop = null
  if (storage.isDragging || !isOthersEdit(transaction)) return

  storage.scroller ??= scrollerOf(view.dom)
  if (!storage.scroller) return

  const bounds = storage.scroller.getBoundingClientRect()
  const top = caretTop(view)
  const isInSight = top >= bounds.top && top <= bounds.bottom
  if (isInSight) {
    storage.caretTop = top
  }
}

function listenForDrags(storage: Storage, dom: HTMLElement) {
  function onPointerDown() {
    storage.isDragging = true
  }

  function onPointerUp() {
    storage.isDragging = false
  }

  dom.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onPointerUp)
  return () => {
    dom.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointerup', onPointerUp)
  }
}

// Keeps this tab's own line where it is on screen while others edit above it, scrolled or not
export const SteadyCaret = Extension.create<object, Storage>({
  name: 'steadyCaret',

  addStorage() {
    return { scroller: null, caretTop: null, isDragging: false, stop: null }
  },

  onCreate() {
    const storage = this.storage
    const view = this.editor.view
    function onBeforeTransaction({ transaction }: { transaction: Transaction }) {
      measure(storage, view, transaction)
    }

    this.editor.on('beforeTransaction', onBeforeTransaction)
    const stopDrags = listenForDrags(storage, view.dom)
    storage.stop = () => {
      this.editor.off('beforeTransaction', onBeforeTransaction)
      stopDrags()
    }
  },

  onTransaction() {
    const before = this.storage.caretTop
    this.storage.caretTop = null
    if (before === null || !this.storage.scroller) return

    this.storage.scroller.scrollTop += caretTop(this.editor.view) - before
  },

  onDestroy() {
    this.storage.stop?.()
  },
})
