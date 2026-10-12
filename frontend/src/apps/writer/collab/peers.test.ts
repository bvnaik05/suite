import type { Peer } from '@suite/collab-client'
import { describe, expect, it, vi } from 'vitest'

import { peopleOf } from './peers'

const searchUsers = vi.hoisted(() => vi.fn())
vi.mock('@/apps/writer/drive', () => ({ searchUsers }))

const PEER_ID = 2 ** 31 + 7

describe('Writer peers', () => {
  it('lists each signed-in person once and every guest tab apart', () => {
    searchUsers.mockResolvedValue([])
    const color = '#E5484D'

    const peers: Peer[] = [
      { pid: PEER_ID, user: 'cy@x.com', color },
      { pid: PEER_ID + 1, user: 'cy@x.com', color },
      { pid: 2 ** 31 + 1_000_000, user: 'Guest', color },
      { pid: 2 ** 31 + 2_000_000, user: 'Guest', color },
    ]

    const people = peopleOf(peers)

    expect(people.map((person) => person.id)).toEqual(['cy@x.com', 'Guest', 'Guest'])
    expect(people[1].name).toMatch(/^Guest [0-9A-Z]{4}$/)
    expect(people[1].name).not.toBe(people[2].name)
  })
})
