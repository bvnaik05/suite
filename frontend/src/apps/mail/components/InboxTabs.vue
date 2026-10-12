<template>
  <!-- The Inbox's category tabs, a row of their own between the header and the toolbar that acts on
       the open one. A phone gets a row of pills that scrolls sideways. -->
  <div
    v-if="isMobile"
    class="shrink-0 overflow-x-auto px-4 pb-3 [scrollbar-width:none]"
    data-testid="inbox-tabs"
  >
    <Tabs :model-value="active">
      <TabList variant="ghost" size="md">
        <TabTrigger
          v-for="tab in tabs"
          :key="tab.category"
          :value="tab.category"
          :route="routeFor(tab.category)"
          :icon-left="tab.icon"
          :label="tab.label"
        >
          <template #suffix>
            <Badge v-if="countShown(tab)" size="sm">{{ tab.unread }}</Badge>
          </template>
        </TabTrigger>
      </TabList>
    </Tabs>
  </div>

  <!-- Measured on the row, not the tabs: what the list has room for, whatever the tabs show. -->
  <div
    v-else
    ref="row"
    class="shrink-0 sm:border-l sm:border-l-transparent"
    data-testid="inbox-tabs"
  >
    <Tabs :model-value="active">
      <!-- As tall as the toolbar below, with the gutter inside the rail, so the first tab lines up
           with the toolbar's checkbox. -->
      <TabList variant="underline" size="md" class="h-12 w-full px-3 sm:px-5">
        <!-- A list too narrow for every name names only the open tab; the rest show an icon and a
             count, and name themselves in a tooltip. They keep the named tabs' height (frappe-ui's
             icon-only trigger is a fixed square a count spills out of). Only a named tab gives way
             to a still narrower list, by truncating. -->
        <Tooltip
          v-for="tab in tabs"
          :key="tab.category"
          :text="tab.label"
          :disabled="!iconOnly(tab)"
        >
          <TabTrigger
            :value="tab.category"
            :route="routeFor(tab.category)"
            :icon-left="tab.icon"
            :label="iconOnly(tab) ? undefined : tab.label"
            :aria-label="iconOnly(tab) ? tab.label : undefined"
            :class="iconOnly(tab) ? 'shrink-0' : 'min-w-0 [&>[data-state]]:min-w-0'"
          >
            <template #suffix>
              <Badge v-if="countShown(tab)" size="sm">{{ tab.unread }}</Badge>
            </template>
          </TabTrigger>
        </Tooltip>
      </TabList>
    </Tabs>
  </div>
</template>

<script setup lang="ts">
import { useElementSize } from '@vueuse/core'
import { Badge, TabList, Tabs, TabTrigger, Tooltip } from 'frappe-ui'
import { computed, useTemplateRef } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

import type { InboxCategory, InboxTab } from '@/apps/mail/composables/useInboxTabs'
import { useScreenSize } from '@/apps/mail/utils/composables'

const { tabs, active, routeFor } = defineProps<{
  tabs: InboxTab[]
  active: InboxCategory
  routeFor: (category: InboxCategory) => RouteLocationRaw
}>()

const { isMobile } = useScreenSize()

// About what a tab needs to show its name and count, beside the row's gutters.
const NAMED_TAB_WIDTH = 140
const { width } = useElementSize(useTemplateRef<HTMLElement>('row'))
const narrow = computed(() => width.value > 0 && width.value < NAMED_TAB_WIDTH * tabs.length + 40)

const iconOnly = (tab: InboxTab) => narrow.value && tab.category !== active

// Primary's unread is the Inbox's own, counted beside it in the sidebar.
const countShown = (tab: InboxTab) => tab.category !== 'primary' && tab.unread > 0
</script>
