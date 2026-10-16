import { TextSelection } from '@tiptap/pm/state'

// Shows the comment button over a text selection unless a comment is being written
export function bubbleMenuOptions({ comments }) {
  return {
    shouldShow: ({ state, from, to }) => {
      if (from === to) return false
      // Only show for text selections — not node selections (images) or cell selections (tables)
      if (!(state.selection instanceof TextSelection)) return false
      let hide = false
      comments.forEach((k) => (k.new || k.edit) && (hide = true))
      return !hide
    },
  }
}
