import { expect, it } from 'vitest'

import { registration } from './policy'

// How a filing changes a cached list before the server answers: the conversation's rows leave the
// list it names as left, and every other list keeps them until it is read again.
const updateOf = () => {
  const policy = registration.policy({
    id: 'file_mails',
    kind: 'mutation',
    publicName: 'messages.file',
  } as never) as {
    effects: {
      optimisticReads: { update: (input: unknown, query: unknown, data: unknown) => unknown }
    }
  }
  return policy.effects.optimisticReads.update
}

const list = { rows: [{ id: 'q', messages: [{ id: 'q' }, { id: 'r' }] }, { id: 'other' }] }
const archived = { account: 'a', ids: ['q', 'r'], action: 'archive', leaves: 'inbox' }

it('takes an archived conversation off the Inbox at once', () => {
  const update = updateOf()
  expect(update(archived, { account: 'a', mailbox: 'inbox' }, list)).toEqual({
    rows: [{ id: 'other' }],
  })
})

it('leaves it on a list it did not leave, such as a folder of yours', () => {
  const update = updateOf()
  expect(update(archived, { account: 'a', mailbox: 'projects' }, list)).toBeUndefined()
  expect(
    update({ ...archived, leaves: null }, { account: 'a', mailbox: 'inbox' }, list),
  ).toBeUndefined()
})
