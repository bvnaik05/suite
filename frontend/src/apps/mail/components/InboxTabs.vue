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
            <Badge v-if="countShown(tab)" size="sm">{{ tab.unread }}</Badge>
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
    @transitionend="settleWhenStill"
  >
    <Tabs :model-value="active">
      <!-- As tall as the toolbar below, with the gutter inside the rail, so the first tab lines up
           with the toolbar's checkbox. The rail is the row's, not the tab list's, so it runs on
           under the menu at the row's end: the menu sits outside the tab list, whose keyboard
           handling would otherwise move focus from it onto a tab, opening that tab. -->
      <div class="flex h-12 items-center border-b border-outline-gray-1 px-3 sm:px-5">
        <!-- Each tab underlines itself (below) in place of the list's one sliding indicator: that one
           measures the open tab once, as it is clicked, so it lags behind a name still opening. A
           narrow row sets its tabs 16px apart rather than 24, room for the open tab's whole name
           in the split view's list: a name that only just doesn't fit would end its opening by
           trading its clipped end for an ellipsis. -->
        <TabList
          variant="underline"
          size="md"
          class="h-full min-w-0 flex-1 overflow-x-clip data-[slot=tab-list]:border-b-0 [&>[data-slot=tab-indicator]]:hidden"
          :class="[
            narrow && 'data-[slot=tab-list]:gap-4',
            animated &&
              'transition-[column-gap] duration-300 ease-in-out motion-reduce:transition-none',
          ]"
        >
          <!-- A list too narrow for every name names only the open tab; the rest show an icon and a
             count, and name themselves in a tooltip. A name opens and closes rather than snapping,
             so the tab draws its own icon, name and count (the label frappe-ui draws can only
             appear or vanish). Only a named tab gives way to a still narrower list, by truncating.
             A closed name stays in the tab for screen readers. The tooltip is never disabled, only
             emptied: disabling it re-creates the tab, and a re-created tab can't animate. -->
          <Tooltip v-for="tab in tabs" :key="tab.category" :text="iconOnly(tab) ? tab.label : ''">
            <TabTrigger
              :value="tab.category"
              :route="routeFor(tab.category)"
              class="relative items-center self-stretch after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-[var(--outline-gray-8)] after:opacity-0 data-[state=active]:after:opacity-100"
              :class="[
                iconOnly(tab) || resizing ? 'shrink-0' : 'min-w-0 [&>[data-state]]:min-w-0',
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
                  <!-- Clipped, not ellipsed, while it opens or closes: an ellipsis is for a name that
                     won't fit, not one still growing. -->
                  <span
                    class="min-w-0 overflow-hidden whitespace-nowrap"
                    :class="settling ? 'text-clip' : 'text-ellipsis'"
                  >
                    {{ tab.label }}
                  </span>
                </span>
                <Badge v-if="countShown(tab)" size="sm" class="ml-2 shrink-0">{{
                  tab.unread
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

// While names open and close (300ms, as their transition), none is ellipsed: it is still growing.
const settling = ref(false)
// When the row turns narrow (a thread opens beside the list), the open tab keeps its name while the
// others close. For that moment the row needs more room than it has, and the open tab, the only one
// that may shrink, would be squeezed to nothing and back: so none shrinks, and the row clips what
// runs past its edge. A tab switch needs none of that: the opening name starts from nothing and grows
// into the room the closing one gives up.
const resizing = ref(false)
// Settled when the names have stopped moving, not on a timer: the transitions start a frame after
// the change and ease out, so a timer of their length ends while a name is still a fraction of a pixel
// short of its width, and its last letters flash an ellipsis. The timer is only a backstop.
let backstop: ReturnType<typeof setTimeout> | undefined
const settled = () => {
  clearTimeout(backstop)
  settling.value = resizing.value = false
}
const settle = (dueToResize: boolean) => {
  if (!animated.value) return
  settling.value = true
  resizing.value = dueToResize
  clearTimeout(backstop)
  backstop = setTimeout(settled, 1000)
}
const settleWhenStill = () => {
  if (!settling.value) return
  const moving = row.value
    ?.getAnimations({ subtree: true })
    .some((animation) => animation.playState === 'running')
  if (!moving) settled()
}
watch(narrow, () => settle(true))
watch(
  () => active,
  () => settle(false),
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

// Primary's unread is the Inbox's own, counted beside it in the sidebar.
const countShown = (tab: InboxTab) => tab.category !== 'primary' && tab.unread > 0
</script>
