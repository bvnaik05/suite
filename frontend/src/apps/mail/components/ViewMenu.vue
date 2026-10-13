<template>
  <!-- How the list is laid out, in one menu with the page's actions: Split View, which lays out the
       whole page, list and pane; and in an Inbox, whether it is split into categories and which get
       a tab. Each switch applies on click. -->
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
import { computed } from 'vue'

import { useTabChoiceMenu } from '@/apps/mail/composables/useInboxTabs'
import { useReadingPane, useToggleReadingPane } from '@/apps/mail/utils/composables'

/** Whether the view is an Inbox, whose categories the menu then offers (where the site sorts mail). */
const { inbox = false } = defineProps<{ inbox?: boolean }>()

const showReadingPane = useReadingPane()
const toggleReadingPane = useToggleReadingPane()
const { categoriesSwitch, tabGroups } = useTabChoiceMenu()

const menu = computed(() => [
  {
    group: __('Layout'),
    options: [
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
