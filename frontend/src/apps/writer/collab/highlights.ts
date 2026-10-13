import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

import type { DocumentThread } from '@/apps/drive'

import { placeThread } from './places'

const highlightsKey = new PluginKey<DecorationSet>('threadHighlights')

/** Marks the text each open thread is on, found again after every change to the document. */
export const ThreadHighlights = Extension.create<{ threads: () => readonly DocumentThread[] }>({
  name: 'threadHighlights',

  addOptions() {
    return { threads: () => [] }
  },

  addProseMirrorPlugins() {
    const threads = () => this.options.threads()
    return [
      new Plugin({
        key: highlightsKey,
        state: {
          init: (_, state) => highlights(state, threads()),
          apply: (transaction, previous, _, state) => {
            if (!transaction.docChanged && !transaction.getMeta(highlightsKey)) {
              return previous
            }

            return highlights(state, threads())
          },
        },
        props: {
          decorations: (state) => highlightsKey.getState(state),
        },
      }),
    ]
  },
})

/** Marks the threads again, once they are read from Drive. */
export function redrawThreads(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(highlightsKey, true))
}

function highlights(state: EditorState, threads: readonly DocumentThread[]) {
  const decorations: Decoration[] = []
  for (const thread of threads) {
    const place = placeThread(state, thread.anchor)
    if (!thread.resolved && place.kind === 'text') {
      decorations.push(Decoration.inline(place.from, place.to, { 'data-thread': thread.name }))
    }
  }

  return DecorationSet.create(state.doc, decorations)
}
