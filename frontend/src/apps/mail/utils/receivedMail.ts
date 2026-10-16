/**
 * Mail you received, told from your own as the filing rules tell it (suite/mail/filing.py): not a
 * draft, and not filed in Sent — what you send is kept there, and a draft in Drafts. Archive and Junk
 * act only on received mail, so a conversation of nothing but your own has nothing to archive or junk.
 */
type Filed = { draft?: number | boolean | null; mailboxes: { mailbox_id: string }[] }

export const isReceived = (mail: Filed, sentId?: string): boolean =>
  !mail.draft && !mail.mailboxes.some((mailbox) => mailbox.mailbox_id === sentId)

/** Whether any of these messages is mail you received. */
export const holdsReceivedMail = (mails: Filed[], sentId?: string): boolean =>
  mails.some((mail) => isReceived(mail, sentId))

/**
 * Whether Archive would still do something to these messages: some mail you received is outside
 * Archive, or still in the Inbox. Asked of the messages you received, not of a row's own message —
 * in Sent that is your reply, which Archive never touches, so it never reads as archived.
 */
export const archivable = (
  mails: Filed[],
  boxes: { sent?: string; archive?: string; inbox?: string },
): boolean =>
  mails.some((mail) => {
    if (!isReceived(mail, boxes.sent)) return false
    const ids = mail.mailboxes.map((mailbox) => mailbox.mailbox_id)
    return !ids.includes(boxes.archive ?? '') || ids.includes(boxes.inbox ?? '')
  })

/**
 * Whether Unarchive would do something: the mail you received is archived, and none of it is still
 * in the Inbox. Archive's opposite, so the two share one place and only one of them shows.
 */
export const unarchivable = (
  mails: Filed[],
  boxes: { sent?: string; archive?: string; inbox?: string },
): boolean =>
  !archivable(mails, boxes) &&
  mails.some(
    (mail) =>
      isReceived(mail, boxes.sent) &&
      mail.mailboxes.some((mailbox) => mailbox.mailbox_id === boxes.archive),
  )
