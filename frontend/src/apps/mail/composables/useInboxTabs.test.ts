import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import {
  useClearTab,
  useInboxTabs,
  useTabChoice,
  useTabClearMenu,
  type InboxCategory,
} from './useInboxTabs'

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
// What the server answers a clearing with: the ids it changed, by account and mailbox.
const answers = vi.hoisted(() => new Map<unknown, unknown>())
const routes = vi.hoisted(() => ({
  updatePreferences: { name: 'updatePreferences' },
  markTabRead: { name: 'markTabRead' },
  markUnifiedTabRead: { name: 'markUnifiedTabRead' },
  archiveTab: { name: 'archiveTab' },
  archiveUnifiedTab: { name: 'archiveUnifiedTab' },
  seen: { name: 'seen' },
  setFolders: { name: 'setFolders' },
}))
vi.mock('@/api', () => ({
  api: {
    mail: {
      settings: { updatePreferences: routes.updatePreferences },
      messages: routes,
    },
  },
  client: {
    mutation: async (reference: unknown, input: unknown) => {
      saved.push(input)
      if (held.on) await new Promise<void>((resolve) => held.release.push(resolve))
      return answers.get(reference)
    },
  },
}))
vi.mock('@/apps/mail/utils', () => ({
  raiseToast: (message: string) => toasts.push(message),
  raiseOptimisticToast: async (done: Promise<unknown>, message: string) => {
    await done
    toasts.push(message)
  },
}))
// Mail's one undo slot, as the toast's Undo and Cmd/Ctrl+Z both reach it.
const undoSlot = vi.hoisted(() => ({ action: undefined as (() => unknown) | undefined }))
vi.mock('@/apps/mail/utils/composables', () => ({
  useSettings: () => ({ openSettings: () => {} }),
  useUndo: () => ({
    setUndoAction: (action?: () => unknown) => (undoSlot.action = action),
    undo: () => undoSlot.action?.(),
  }),
}))

const INBOX = { name: 'mail-mailbox', params: { accountId: 'ih', mailbox: 'inbox' } }

const tabsFor = (scope: 'account' | 'unified' | false) =>
  useInboxTabs(
    () => scope,
    () => INBOX,
  )

describe('the Inbox tabs', () => {
  beforeEach(() => {
    vi.stubGlobal('__', (text: string, args: string[] = []) =>
      text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]),
    )
    answers.clear()
    undoSlot.action = undefined
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

  it('turn off altogether, saying how to get them back, and Undo turns them on again', async () => {
    const { setSplit } = useTabChoice()

    await setSplit(false)
    expect(saved).toEqual([{ split_inbox: 0 }])
    expect(toasts).toEqual(['Categories turned off.'])

    // What the toast's Undo and Cmd/Ctrl+Z both run.
    await undoSlot.action?.()
    expect(saved).toEqual([{ split_inbox: 0 }, { split_inbox: 1 }])
    expect(toasts).toEqual(['Categories turned off.', 'Categories turned on.'])
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

  it('clear any list by marking all of it read, and only a bulk tab by archiving or trashing it', () => {
    const menuFor = useTabClearMenu(() => ({ account: 'ih', mailbox: 'inbox' }))
    const labels = (scope: Parameters<typeof menuFor>[0]) =>
      menuFor(scope).flatMap((group) => group.options.map((option) => option.label))

    expect(labels({ category: 'primary', name: 'Primary' })).toEqual(['Mark all as read'])
    expect(labels({ name: 'Archive' })).toEqual(['Mark all as read'])
    expect(labels({ category: 'updates', name: 'Updates' })).toEqual([
      'Mark all as read',
      'Archive all',
      'Move all to Trash',
    ])
  })

  it('say what a clearing did, and what its Undo put back', async () => {
    const { markAllRead, archiveAll } = useClearTab(() => ({ account: 'ih', mailbox: 'inbox' }))
    const before = { id: 'c', mailbox_ids: ['inbox', 'project'], junk: 0 }
    answers.set(routes.markTabRead, { cleared: [{ account: 'ih', ids: ['a', 'b'] }], failed: [] })
    answers.set(routes.archiveTab, { cleared: [{ account: 'ih', mails: [before] }], failed: [] })

    await markAllRead({ category: 'updates', name: 'Updates' })
    await undoSlot.action?.()
    await archiveAll({ category: 'updates', name: 'Updates' })
    await undoSlot.action?.()

    expect(toasts).toEqual([
      'Updates mail marked as read.',
      'Updates mail marked as unread.',
      'Updates mail archived.',
      'Updates mail moved back.',
    ])
    // Undo touches exactly what was cleared, and puts it back in every folder it was in.
    expect(saved).toContainEqual({ account: 'ih', ids: ['a', 'b'], seen: false })
    expect(saved).toContainEqual({ account: 'ih', mails: [before] })
  })

  it('say so when a folder has nothing unread to mark', async () => {
    const { markAllRead } = useClearTab(() => ({ account: 'ih', mailbox: 'archive' }))
    answers.set(routes.markTabRead, { cleared: [], failed: [] })

    await markAllRead({ name: 'Archive' })

    expect(toasts).toEqual(['Nothing unread in Archive.'])
    expect(undoSlot.action).toBeUndefined()
  })

  it('keep what an account cleared before failing undoable, and say it did not finish', async () => {
    const { markAllRead } = useClearTab(() => ({ folder: 'inbox' }))
    answers.set(routes.markUnifiedTabRead, {
      cleared: [{ account: 'ih', ids: ['a'] }],
      failed: ['q9'],
    })

    await markAllRead({ category: 'updates', name: 'Updates' })
    await undoSlot.action?.()

    expect(toasts).toEqual([
      'Updates mail marked as read.',
      'Not all Updates mail could be cleared.',
      'Updates mail marked as unread.',
    ])
    expect(saved).toContainEqual({ account: 'ih', ids: ['a'], seen: false })
  })

  it("clear only what the list's filter shows, and say so", async () => {
    const { archiveAll, markAllRead } = useClearTab(() => ({ folder: 'inbox' }))
    answers.set(routes.archiveUnifiedTab, {
      cleared: [{ account: 'ih', mails: [{ id: 'c', mailbox_ids: ['inbox'], junk: 0 }] }],
      failed: [],
    })
    answers.set(routes.markUnifiedTabRead, { cleared: [{ account: 'ih', ids: ['a'] }], failed: [] })

    await archiveAll({ category: 'social', name: 'Social', filter: 'unscreened' })
    await undoSlot.action?.()
    await markAllRead({ category: 'social', name: 'Social', filter: 'unread' })

    expect(saved).toContainEqual({ folder: 'inbox', category: 'social', filter_by: 'unscreened' })
    expect(saved).toContainEqual({ folder: 'inbox', category: 'social', filter_by: 'unread' })
    expect(toasts).toEqual([
      'Social mail from unknown senders archived.',
      'Social mail from unknown senders moved back.',
      'Unread Social mail marked as read.',
    ])
  })
})
