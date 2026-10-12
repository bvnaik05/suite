import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { useInboxTabs, useTabChoice, type InboxCategory } from './useInboxTabs'

type Counts = { category: InboxCategory; unread_threads: number }[]

const state = vi.hoisted(() => ({
  route: null as unknown as { query: Record<string, string> },
  store: null as unknown as {
    inboxTabs: InboxCategory[]
    tabCounts: { data: Counts | null }
    unifiedTabCounts: { data: Counts | null }
    userResource: {
      data: { email_classification: boolean; split_inbox: 0 | 1; inbox_tabs: InboxCategory[] }
    }
  },
}))
vi.mock('vue-router', () => ({ useRoute: () => state.route }))
vi.mock('@/apps/mail/stores/user', () => ({ userStore: () => state.store }))
const saved = vi.hoisted(() => [] as unknown[])
const toasts = vi.hoisted(() => [] as string[])
// Saves resolve at once, unless a test holds them to see what happens while they are pending.
const held = vi.hoisted(() => ({ on: false, release: [] as (() => void)[] }))
vi.mock('@/api', () => ({
  api: { mail: { settings: { updatePreferences: {} } } },
  client: {
    mutation: async (_reference: unknown, input: unknown) => {
      saved.push(input)
      if (held.on) await new Promise<void>((resolve) => held.release.push(resolve))
    },
  },
}))
vi.mock('@/apps/mail/utils', () => ({ raiseToast: (message: string) => toasts.push(message) }))
vi.mock('@/apps/mail/utils/composables', () => ({
  useSettings: () => ({ openSettings: () => {} }),
}))

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
    saved.length = 0
    toasts.length = 0
    state.store = reactive({
      userResource: {
        data: {
          email_classification: true,
          split_inbox: 1,
          inbox_tabs: ['primary', 'updates', 'forums', 'promotions'],
        },
      },
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

  it('are chosen by turning categories on and off, Primary leading any that are on', async () => {
    const { choices, setTab } = useTabChoice()
    expect(choices.value.map((choice) => [choice.category, choice.on])).toEqual([
      ['updates', true],
      ['forums', true],
      ['promotions', true],
      ['social', false],
    ])

    await setTab('social', true)
    await setTab('forums', false)

    expect(saved).toEqual([
      { inbox_tabs: ['primary', 'updates', 'forums', 'promotions', 'social'] },
      { inbox_tabs: ['primary', 'updates', 'promotions'] },
    ])
    expect(toasts).toEqual([])
  })

  it('turn off altogether, saying how to get them back', async () => {
    const { setSplit } = useTabChoice()

    await setSplit(false)

    expect(saved).toEqual([{ split_inbox: 0 }])
    expect(toasts).toEqual(['Categories are off.'])
  })

  it('build each switch on the last, while the earlier saves are still on their way', async () => {
    held.on = true
    const { setTab } = useTabChoice()

    const first = setTab('social', true)
    const second = setTab('forums', false)
    held.on = false
    held.release.forEach((release) => release())
    await Promise.all([first, second])

    expect(saved).toEqual([
      { inbox_tabs: ['primary', 'updates', 'forums', 'promotions', 'social'] },
      { inbox_tabs: ['primary', 'updates', 'promotions', 'social'] },
    ])
  })
})
