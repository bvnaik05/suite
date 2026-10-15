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
