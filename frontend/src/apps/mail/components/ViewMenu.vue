<template>
  <!-- How the list is laid out, in one menu with the page's actions: Split View, which lays out the
       whole page, list and pane; how the list is grouped by date; and in an Inbox, whether it is
       split into categories and which get a tab. Each choice applies on click. -->
  <Dropdown :options="menu" align="end">
    <Button variant="ghost" :tooltip="__('View')" :aria-label="__('View')">
      <template #icon>
        <span class="lucide-settings-2 icon" aria-hidden="true" />
      </template>
    </Button>
  </Dropdown>
</template>

<script setup lang="ts">
import { Button, Dropdown } from 'frappe-ui'
import { computed, h } from 'vue'

import { api, client } from '@/api'
import { useTabChoiceMenu } from '@/apps/mail/composables/useInboxTabs'
import { userStore } from '@/apps/mail/stores/user'
import { useReadingPane, useToggleReadingPane } from '@/apps/mail/utils/composables'

/** Whether the view is an Inbox, whose categories the menu then offers (where the site sorts mail). */
const { inbox = false } = defineProps<{ inbox?: boolean }>()

const showReadingPane = useReadingPane()
const toggleReadingPane = useToggleReadingPane()
const { categoriesSwitch, tabGroups } = useTabChoiceMenu()

// Grouping the list by date: the same choice as Settings → Layout, saved as it is picked.
const { userResource } = userStore()
const GROUPINGS = [
  { value: 'None', label: () => __('None') },
  { value: 'Day', label: () => __('Day') },
  { value: 'Month', label: () => __('Month') },
] as const
const groupBy = (value: (typeof GROUPINGS)[number]['value']) =>
  void client.mutation(api.mail.settings.updatePreferences, { group_messages_by: value })
const current = computed(
  () =>
    GROUPINGS.find((grouping) => grouping.value === userResource.data?.group_messages_by) ??
    GROUPINGS[0],
)

const menu = computed(() => [
  {
    group: __('Layout'),
    options: [
      // Grouping by date, a submenu of its own, leading so the switches sit together below it
      // (Categories last, over the tabs it shows). The row names the current choice, as the switches
      // show theirs, and the submenu ticks it (a selected row's fill reads as hover). The row's
      // suffix takes the chevron's place, so it brings its own.
      {
        label: __('Group by'),
        icon: 'lucide-calendar-days',
        slots: {
          suffix: () =>
            h(
              'span',
              { class: 'ml-auto flex items-center gap-1 pl-4 leading-tighter text-ink-gray-5' },
              [
                current.value.label(),
                h('span', {
                  class: 'lucide-chevron-right size-4 text-ink-gray-6',
                  'aria-hidden': 'true',
                }),
              ],
            ),
        },
        submenu: GROUPINGS.map((grouping) => ({
          label: grouping.label(),
          slots:
            grouping === current.value
              ? {
                  suffix: () =>
                    h('span', {
                      class: 'lucide-check size-4 text-ink-gray-7',
                      'aria-hidden': 'true',
                    }),
                }
              : undefined,
          onClick: () => groupBy(grouping.value),
        })),
      },
      {
        label: __('Split view'),
        icon: 'lucide-panel-left',
        switch: true as const,
        switchValue: showReadingPane.value,
        onClick: () => void toggleReadingPane(),
      },
      ...(inbox && categoriesSwitch.value ? [categoriesSwitch.value] : []),
    ],
  },
  ...(inbox ? tabGroups.value : []),
])
</script>
