import { computed } from 'vue'
import { useRoute, type RouteLocationNamedRaw } from 'vue-router'

import { userStore } from '@/apps/mail/stores/user'

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
