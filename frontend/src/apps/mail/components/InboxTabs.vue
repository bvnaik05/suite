<template>
  <!-- The Inbox's category tabs, a row of their own between the header and the toolbar that acts on
       the open one. A phone gets a row of pills that scrolls sideways. -->
  <div
    v-if="isMobile"
    class="shrink-0 overflow-x-auto px-4 pb-3 [scrollbar-width:none]"
    data-testid="inbox-tabs"
  >
    <Tabs :model-value="active" class="flex items-center gap-1">
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
            <Badge v-if="countShown(tab)" size="sm">{{ countOf(tab) }}</Badge>
          </template>
        </TabTrigger>
      </TabList>
      <Dropdown :options="choiceMenu">
        <Button variant="ghost" :aria-label="__('Choose categories')">
          <template #icon>
            <span class="lucide-settings-2 icon" aria-hidden="true" />
          </template>
        </Button>
      </Dropdown>
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
           with the toolbar's checkbox. The rail is the row's, not the tab list's, so it runs on
           under the menu at the row's end: the menu sits outside the tab list, whose keyboard
           handling would otherwise move focus from it onto a tab, opening that tab. -->
      <div class="flex h-12 items-center border-b border-outline-gray-1 px-3 sm:px-5">
        <!-- Scrolls sideways rather than squeezing its tabs; pb-px keeps the underlines inside what
           scrolls. Each tab underlines itself: the list's sliding indicator measures the open tab
           once, as it is clicked, so it lags behind a name still opening. A narrow row sets its
           tabs closer, room for the open tab's whole name in the split view's list. -->
        <TabList
          variant="underline"
          size="md"
          class="h-full min-w-0 flex-1 overflow-x-auto pb-px [scrollbar-width:none] data-[slot=tab-list]:border-b-0 [&>[data-slot=tab-indicator]]:hidden"
          :class="[
            narrow && 'data-[slot=tab-list]:gap-4',
            animated &&
              'transition-[column-gap] duration-300 ease-in-out motion-reduce:transition-none',
          ]"
        >
          <!-- A list too narrow for every name names only the open tab; the rest show an icon and a
             count, and name themselves in a tooltip. The tab draws its own icon, name and count so
             a name can open and close rather than snap (frappe-ui's label can only appear or
             vanish); a closed name stays in the tab for screen readers. The tooltip is emptied,
             never disabled: disabling it re-creates the tab, and a re-created tab can't animate. -->
          <Tooltip v-for="tab in tabs" :key="tab.category" :text="iconOnly(tab) ? tab.label : ''">
            <TabTrigger
              :value="tab.category"
              :route="routeFor(tab.category)"
              class="relative items-center self-stretch after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-[var(--outline-gray-8)] after:opacity-0 data-[state=active]:after:opacity-100"
              :class="[
                'shrink-0',
                animated &&
                  'after:transition-opacity after:duration-300 motion-reduce:after:transition-none',
              ]"
            >
              <span class="flex min-w-0 items-center">
                <span :class="[tab.icon, 'size-4 shrink-0']" aria-hidden="true" />
                <!-- A grid column eases between nothing and the name's own width. -->
                <span
                  class="grid min-w-0"
                  :class="[
                    iconOnly(tab)
                      ? 'ml-0 grid-cols-[0fr] opacity-0'
                      : 'ml-2 grid-cols-[1fr] opacity-100',
                    animated &&
                      'transition-[grid-template-columns,margin,opacity] duration-300 ease-in-out motion-reduce:transition-none',
                  ]"
                >
                  <!-- Clipped while it opens or closes; at rest a name always fits, never ellipsed. -->
                  <span class="min-w-0 overflow-hidden whitespace-nowrap text-clip">
                    {{ tab.label }}
                  </span>
                </span>
                <Badge v-if="countShown(tab)" size="sm" class="ml-2 shrink-0">{{
                  countOf(tab)
                }}</Badge>
              </span>
            </TabTrigger>
          </Tooltip>
        </TabList>
        <!-- Which categories get a tab, and categories off altogether, in place (as in Mail
             settings). Pulled out by as much as the toolbar's own buttons, so it lines up with
             Refresh below, and drawn as Refresh is, with Mail's .icon. -->
        <div class="-mr-1.5 flex shrink-0 items-center pl-2">
          <Dropdown :options="choiceMenu" align="end">
            <Button
              variant="ghost"
              :tooltip="__('Choose categories')"
              :aria-label="__('Choose categories')"
            >
              <template #icon>
                <span class="lucide-settings-2 icon" aria-hidden="true" />
              </template>
            </Button>
          </Dropdown>
        </div>
      </div>
    </Tabs>
  </div>
</template>

<script setup lang="ts">
import { useElementSize } from '@vueuse/core'
import { Badge, Button, Dropdown, TabList, Tabs, TabTrigger, Tooltip } from 'frappe-ui'
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

import {
  useTabChoice,
  type InboxCategory,
  type InboxTab,
} from '@/apps/mail/composables/useInboxTabs'
import { useScreenSize } from '@/apps/mail/utils/composables'

const { tabs, active, routeFor } = defineProps<{
  tabs: InboxTab[]
  active: InboxCategory
  routeFor: (category: InboxCategory) => RouteLocationRaw
}>()

const { isMobile } = useScreenSize()

// About what a tab needs to show its name and count, beside the row's gutters and its tab menu.
const NAMED_TAB_WIDTH = 140
const row = useTemplateRef<HTMLElement>('row')
const { width } = useElementSize(row)
// Read once on mount, before the first paint: the observed size only arrives after it, and until
// then every tab would show its name, only to close it again.
const mountedWidth = ref(0)
// Names and underlines animate only once the row has been laid out at its real width.
const animated = ref(false)
onMounted(() => {
  mountedWidth.value = row.value?.offsetWidth ?? 0
  requestAnimationFrame(() => requestAnimationFrame(() => (animated.value = true)))
})
const rowWidth = computed(() => width.value || mountedWidth.value)
const narrow = computed(
  () => rowWidth.value > 0 && rowWidth.value < NAMED_TAB_WIDTH * tabs.length + 80,
)

const iconOnly = (tab: InboxTab) => narrow.value && tab.category !== active

// A list that scrolls keeps the open tab in view.
watch(
  () => active,
  () =>
    requestAnimationFrame(() =>
      row.value
        ?.querySelector('[data-slot=tab-list] [data-state=active]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    ),
)

// A switch per category (Primary has none, being the Inbox's own), the last one on held on, and a
// way to turn categories off altogether.
const { choices, setTab, setSplit } = useTabChoice()
const choiceMenu = computed(() => {
  const onCount = choices.value.filter((choice) => choice.on).length
  return [
    {
      group: __('Categories'),
      options: choices.value.map((choice) => ({
        label: choice.label,
        icon: choice.icon,
        switch: true as const,
        switchValue: choice.on,
        disabled: choice.on && onCount === 1,
        onClick: (on: boolean) => void setTab(choice.category, on),
      })),
    },
    {
      group: '',
      options: [
        {
          label: __('Turn off categories'),
          icon: 'lucide-eye-off',
          onClick: () => void setSplit(false),
        },
      ],
    },
  ]
})

// Every tab counts its unread, Primary too; the sidebar's Inbox counts all of them together.
const countShown = (tab: InboxTab) => tab.unread > 0
// A tab's count stops at 99+: past that the number only widens the tab.
const countOf = (tab: InboxTab) => (tab.unread > 99 ? '99+' : String(tab.unread))
</script>
