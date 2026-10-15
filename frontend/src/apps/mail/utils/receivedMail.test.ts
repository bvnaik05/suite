import { expect, it } from 'vitest'

import { holdsReceivedMail, isReceived } from './receivedMail'

const in_ = (...ids: string[]) => ids.map((mailbox_id) => ({ mailbox_id }))

it('tells mail you received from your sent mail and your drafts', () => {
  expect(isReceived({ mailboxes: in_('inbox', 'projects') }, 'sent')).toBe(true)
  expect(isReceived({ mailboxes: in_('sent', 'projects') }, 'sent')).toBe(false)
  expect(isReceived({ draft: 1, mailboxes: in_('drafts') }, 'sent')).toBe(false)
})

it('finds nothing to archive in a conversation of only your own mail', () => {
  const outreach = [{ mailboxes: in_('sent') }, { draft: 1, mailboxes: in_('drafts') }]
  expect(holdsReceivedMail(outreach, 'sent')).toBe(false)
  expect(holdsReceivedMail([...outreach, { mailboxes: in_('inbox') }], 'sent')).toBe(true)
})
