import { expect, it } from 'vitest'

import { registration } from './policy'

// What a write to mail has read again once it lands, through the policy every caller gets.
const readAgainAfter = (id: string, publicName: string, input: Record<string, unknown> = {}) => {
  const policy = registration.policy({ id, kind: 'mutation', publicName } as never) as {
    effects: { invalidates: (input: unknown) => readonly string[] }
  }
  return policy.effects.invalidates({ account: 'a', ...input })
}

const LIST = 'mail.get_threads'
const COUNT = 'mail.get_mailboxes'

it('reading mail moves only the unread counts: the rows already say so', () => {
  const read = readAgainAfter('set_mails_seen', 'messages.seen')
  expect(read).toContain(COUNT)
  expect(read).toContain('mail.get_tab_counts')
  expect(read).not.toContain(LIST)
  expect(read).not.toContain('mail.get_contacts')
})

it('starring reads nothing again: the rows show the star, and nothing counts them', () => {
  expect(readAgainAfter('set_flagged', 'messages.flag')).toEqual([])
})

it('saving a draft reads nothing again but a new draft’s count', () => {
  expect(readAgainAfter('update_draft_mail', 'messages.updateDraft', { id: 'd' })).toEqual([])
  expect(readAgainAfter('create_mail', 'messages.create', { save_as_draft: true })).toEqual([COUNT])
})

it('sending reads the lists, the Outbox and the people it went to', () => {
  for (const read of [
    readAgainAfter('create_mail', 'messages.create'),
    readAgainAfter('update_draft_mail', 'messages.updateDraft', { id: 'd', submit: true }),
  ]) {
    expect(read).toEqual(
      expect.arrayContaining([LIST, COUNT, 'mail.get_submissions', 'mail.get_email_suggestions']),
    )
  }
})

it('filing reads the lists and counts, and the senders only when it decides on one', () => {
  const archived = readAgainAfter('file_mails', 'messages.file', { action: 'archive' })
  expect(archived).toEqual(expect.arrayContaining([LIST, COUNT]))
  expect(archived).not.toContain('mail.get_screened_addresses')
  expect(archived).not.toContain('mail.get_submissions')

  const junked = readAgainAfter('file_mails', 'messages.file', {
    action: 'junk',
    screen_action: 'Spam',
  })
  expect(junked).toContain('mail.get_screened_addresses')
})

it('unstarring in Starred takes a conversation with no star left off the list at once', () => {
  const policy = registration.policy({
    id: 'set_flagged',
    kind: 'mutation',
    publicName: 'messages.flag',
  } as never) as {
    effects: {
      optimisticReads: { update: (input: unknown, query: unknown, data: unknown) => unknown }
    }
  }
  const update = policy.effects.optimisticReads.update
  const list = {
    rows: [
      {
        id: 'q',
        flagged: 1,
        messages: [
          { id: 'q', flagged: 1 },
          { id: 'r', flagged: 0 },
        ],
      },
      {
        id: 's',
        flagged: 1,
        messages: [
          { id: 's', flagged: 1 },
          { id: 't', flagged: 1 },
        ],
      },
    ],
  }
  const unstar = (ids: string[], mailbox: string) =>
    (
      update({ account: 'a', ids, flagged: false }, { account: 'a', mailbox }, list) as typeof list
    ).rows.map((row) => row.id)

  expect(unstar(['q'], 'starred')).toEqual(['s'])
  // Still starred by another of its messages: it stays.
  expect(unstar(['s'], 'starred')).toEqual(['q', 's'])
  // Anywhere else the row only loses its star.
  expect(unstar(['q'], 'inbox')).toEqual(['q', 's'])
})

it('a conversation is starred while any of its messages is, whichever was starred', () => {
  const policy = registration.policy({
    id: 'set_flagged',
    kind: 'mutation',
    publicName: 'messages.flag',
  } as never) as {
    effects: {
      optimisticReads: { update: (input: unknown, query: unknown, data: unknown) => unknown }
    }
  }
  const update = policy.effects.optimisticReads.update
  // The row stands for its newest message, `n`; `o` is an older one.
  const list = {
    rows: [
      {
        id: 'n',
        flagged: 0,
        messages: [
          { id: 'o', flagged: 0 },
          { id: 'n', flagged: 0 },
        ],
      },
    ],
  }
  const star = (ids: string[], flagged: boolean, data: unknown) =>
    (
      update(
        { account: 'a', ids, flagged },
        { account: 'a', mailbox: 'inbox' },
        data,
      ) as typeof list
    ).rows[0].flagged

  expect(star(['o'], true, list)).toBe(1)
  const both = {
    rows: [
      {
        id: 'n',
        flagged: 1,
        messages: [
          { id: 'o', flagged: 1 },
          { id: 'n', flagged: 1 },
        ],
      },
    ],
  }
  // Unstarring the newest leaves the older one's star on the conversation.
  expect(star(['n'], false, both)).toBe(1)
})
