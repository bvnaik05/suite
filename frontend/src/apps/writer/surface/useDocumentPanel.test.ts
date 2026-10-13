import { toast } from 'frappe-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DocumentSession } from '@/apps/drive'

import { useDocumentPanel } from './useDocumentPanel'

vi.mock('frappe-ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// A Drive session that records the versions taken
function versionsSession() {
  const taken: [string | undefined, string | undefined][] = []
  const session = {
    comments: { list: vi.fn(), create: vi.fn() },
    versions: {
      list: vi.fn(() => Promise.resolve({ rows: [], next_cursor: null })),
      create: vi.fn((kind?: string, label?: string) => {
        taken.push([kind, label])
        return Promise.resolve()
      }),
    },
  } as unknown as Pick<DocumentSession, 'comments' | 'versions'>
  return { session, taken }
}

afterEach(() => vi.clearAllMocks())

describe('saving a named version', () => {
  it('takes the version only after the edits are saved', async () => {
    const { session, taken } = versionsSession()
    const order: string[] = []
    async function saveFirst() {
      await Promise.resolve()
      order.push(`saved before ${taken.length} versions`)
    }

    const isTaken = await useDocumentPanel(session).saveVersion('Draft one', saveFirst)

    expect([isTaken, order, taken]).toEqual([
      true,
      ['saved before 0 versions'],
      [['named', 'Draft one']],
    ])
  })

  it('takes no version when the edits could not be saved, and says why', async () => {
    const { session, taken } = versionsSession()
    async function saveFirst() {
      throw new Error('No version was taken: saving is paused.')
    }

    const isTaken = await useDocumentPanel(session).saveVersion('Draft one', saveFirst)

    expect([isTaken, taken, vi.mocked(toast.error).mock.calls]).toEqual([
      false,
      [],
      [['No version was taken: saving is paused.']],
    ])
  })
})
