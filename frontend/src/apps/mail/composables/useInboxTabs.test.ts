import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { useInboxTabs, type InboxCategory } from './useInboxTabs'

type Counts = { category: InboxCategory; unread_threads: number }[]

const state = vi.hoisted(() => ({
  route: null as unknown as { query: Record<string, string> },
  store: null as unknown as {
    inboxTabs: InboxCategory[]
    tabCounts: { data: Counts | null }
    unifiedTabCounts: { data: Counts | null }
  },
}))
vi.mock('vue-router', () => ({ useRoute: () => state.route }))
vi.mock('@/apps/mail/stores/user', () => ({ userStore: () => state.store }))

const INBOX = { name: 'mail-mailbox', params: { accountId: 'ih', mailbox: 'inbox' } }

const tabsFor = (scope: 'account' | 'unified' | false) =>
  useInboxTabs(
    () => scope,
    () => INBOX,
  )

describe('the Inbox tabs', () => {
  beforeEach(() => {
    vi.stubGlobal('__', (text: string) => text)
    state.route = reactive({ query: {} })
    state.store = reactive({
      inboxTabs: ['primary', 'updates', 'forums', 'promotions'],
      tabCounts: {
        data: [
          { category: 'primary', unread_threads: 12 },
          { category: 'updates', unread_threads: 79 },
          { category: 'forums', unread_threads: 0 },
          { category: 'promotions', unread_threads: 2 },
        ],
      },
      unifiedTabCounts: { data: [{ category: 'updates', unread_threads: 90 }] },
    })
  })

  it('are the categories the server splits the Inbox into, in its order, with their unread', () => {
    const { tabs } = tabsFor('account')

    expect(tabs.value.map((tab) => [tab.label, tab.unread])).toEqual([
      ['Primary', 12],
      ['Updates', 79],
      ['Forums', 0],
      ['Promotions', 2],
    ])
  })

  it('count every account at once in All accounts', () => {
    const { tabs } = tabsFor('unified')

    expect(tabs.value.find((tab) => tab.category === 'updates')?.unread).toBe(90)
    expect(tabs.value.find((tab) => tab.category === 'primary')?.unread).toBe(0)
  })

  it('open Primary unless the route names another tab', () => {
    const { active } = tabsFor('account')
    expect(active.value).toBe('primary')

    state.route.query = { category: 'forums' }
    expect(active.value).toBe('forums')

    // Social has no tab here, so a link to it opens Primary rather than an empty list.
    state.route.query = { category: 'social' }
    expect(active.value).toBe('primary')
  })

  it('are absent from any other list, and from an Inbox that is not split', () => {
    expect(tabsFor(false).tabs.value).toEqual([])
    expect(tabsFor(false).active.value).toBeUndefined()

    state.store.inboxTabs = []
    expect(tabsFor('account').active.value).toBeUndefined()
  })

  it('lead to the list itself, Primary without a category', () => {
    const { routeFor } = tabsFor('account')

    expect(routeFor('updates')).toEqual({ ...INBOX, query: { category: 'updates' } })
    expect(routeFor('primary')).toEqual({ ...INBOX, query: {} })
  })
})
