// Where a thread is filed, as the ticks of a folder menu. A thread can sit in several folders at
// once, so one list of boxes says where it is and changes it, instead of separate Add To and Remove
// From menus that each showed only half of it.

interface Filed {
  mailboxes: { mailbox_id: string }[]
}

export interface FolderTick {
  id: string
  /** In it whole, in part (some of the thread's mail), or not at all. */
  ticked: 'all' | 'some' | 'none'
  /** Whether it can be unticked: taking a message out of its only folder would leave it nowhere. */
  removable: boolean
}

export const folderTicks = (mails: Filed[], folders: string[]): FolderTick[] =>
  folders.map((id) => {
    const inIt = mails.filter((mail) => mail.mailboxes.some((m) => m.mailbox_id === id))
    return {
      id,
      ticked: !inIt.length ? 'none' : inIt.length === mails.length ? 'all' : 'some',
      removable: inIt.every((mail) => mail.mailboxes.length > 1),
    }
  })
