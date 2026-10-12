import { computed } from 'vue'
import { useRoute, type RouteLocationNamedRaw } from 'vue-router'

import { api, client, type InputOf } from '@/api'
import { userStore } from '@/apps/mail/stores/user'
import { raiseToast } from '@/apps/mail/utils'
import { useSettings } from '@/apps/mail/utils/composables'

export type InboxCategory = 'primary' | 'updates' | 'forums' | 'promotions' | 'social'

export interface InboxTab {
  category: InboxCategory
  label: string
  icon: string
  /** Threads in the tab with unread mail. */
  unread: number
}

const TAB_LOOK: Record<InboxCategory, { label: () => string; icon: string }> = {
  primary: { label: () => __('Primary'), icon: 'lucide-inbox' },
  updates: { label: () => __('Updates'), icon: 'lucide-bell' },
  forums: { label: () => __('Forums'), icon: 'lucide-messages-square' },
  promotions: { label: () => __('Promotions'), icon: 'lucide-tag' },
  social: { label: () => __('Social'), icon: 'lucide-users' },
}

/**
 * The category tabs over an Inbox: an account's (`'account'`), or every account's at once
 * (`'unified'`), or none (`false`) for any other list. Which categories have a tab is the server's
 * answer (`inbox_tabs`); none means the Inbox isn't split. The open tab is the route's `category`,
 * Primary when it names none of them, and `undefined` when there are no tabs.
 *
 * `listRoute` is the list the tabs belong to: a tab leads there, leaving any open thread behind,
 * since that thread may not be in the tab being opened.
 */
export const useInboxTabs = (
  scope: () => 'account' | 'unified' | false,
  listRoute: () => RouteLocationNamedRaw,
) => {
  const route = useRoute()
  const store = userStore()

  const tabs = computed<InboxTab[]>(() => {
    const where = scope()
    if (!where) return []
    const counts = (where === 'unified' ? store.unifiedTabCounts.data : store.tabCounts.data) ?? []
    return store.inboxTabs.map((category) => ({
      category,
      label: TAB_LOOK[category].label(),
      icon: TAB_LOOK[category].icon,
      unread: counts.find((count) => count.category === category)?.unread_threads ?? 0,
    }))
  })

  const active = computed<InboxCategory | undefined>(() => {
    if (!tabs.value.length) return undefined
    return tabs.value.find((tab) => tab.category === route.query.category)?.category ?? 'primary'
  })

  const routeFor = (category: InboxCategory): RouteLocationNamedRaw => ({
    ...listRoute(),
    query: category === 'primary' ? {} : { category },
  })

  return { tabs, active, routeFor }
}

/** The categories a person can give a tab or not: all but Primary, which is the Inbox's own. */
const CHOOSABLE: InboxCategory[] = ['updates', 'forums', 'promotions', 'social']

/**
 * The person's categories: offered when the site sorts mail into them at all; whether their Inbox is
 * split into them; and which have a tab when it is, a choice kept while the split is off. At least
 * one is always on: turning the split off is the way to one list.
 */
export const useTabChoice = () => {
  const store = userStore()
  // Not a component's mutation: turning categories off takes the tab row, and its menu, away before
  // the save is answered, and a component's mutation is cancelled when the component goes.
  const save = (input: InputOf<typeof api.mail.settings.updatePreferences>) =>
    client.mutation(api.mail.settings.updatePreferences, input)
  const { openSettings } = useSettings()

  const offered = computed(() => !!store.userResource.data?.email_classification)
  const split = computed(() => !!store.userResource.data?.split_inbox)
  const chosen = computed(() => store.userResource.data?.inbox_tabs ?? [])
  const choices = computed(() =>
    CHOOSABLE.map((category) => ({
      category,
      label: TAB_LOOK[category].label(),
      icon: TAB_LOOK[category].icon,
      on: chosen.value.includes(category),
    })),
  )

  /** Which categories have a tab (Primary leads them). */
  const tabsFor = (categories: InboxCategory[]): InboxCategory[] => {
    const on = CHOOSABLE.filter((category) => categories.includes(category))
    return on.length ? ['primary', ...on] : []
  }
  const saveTabs = (categories: InboxCategory[]) => save({ inbox_tabs: tabsFor(categories) })
  const setTab = (category: InboxCategory, on: boolean) =>
    saveTabs(
      choices.value
        .filter((choice) => (choice.category === category ? on : choice.on))
        .map((choice) => choice.category),
    )

  const setSplit = async (on: boolean) => {
    await save({ split_inbox: on ? 1 : 0 })
    // Off takes the tabs, and their menu with them: say how to get them back.
    if (!on)
      raiseToast(
        __('Categories are off.'),
        'success',
        { label: __('Undo'), onClick: () => void setSplit(true) },
        undefined,
        { label: __('Settings'), onClick: () => openSettings('mail.layout') },
      )
  }

  return {
    offered,
    split,
    choices,
    tabsFor,
    setTab,
    setSplit,
  }
}
