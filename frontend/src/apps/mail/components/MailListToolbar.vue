<template>
  <!-- Mobile: the filter selector alone, in a row the caller places and borders. The
	     mailbox's row sits inside a header block (title, auto-delete banner, selection
	     variant) whose border and loading bar span all of it; All Inboxes has no such
	     block. So the row owns neither — pass `loading` only where the caller isn't
	     already rendering a bar of its own. -->
  <div v-if="isMobile" class="relative flex h-12 items-center px-4">
    <!-- The selector label carries the active filters ("Unread", "Filtered · 2");
		     unticking them in the sheet clears them, so no dismissal chip needed. -->
    <AdaptiveDropdown :options="filterOptions" :title="__('Filter')">
      <button class="flex min-w-0 items-center gap-1.5 text-base !font-medium">
        <span class="truncate">{{ title }}</span>
        <ChevronDown class="text-ink-gray-5 h-4 w-4 shrink-0" />
      </button>
    </AdaptiveDropdown>
    <!-- Actions on the list as a whole, such as clearing an Inbox tab. -->
    <div class="-mr-1.5 ml-auto flex items-center"><slot name="mobile-actions" /></div>
    <LoadingBar v-if="loading" />
  </div>

  <!-- Desktop -->
  <div
    v-else
    class="relative flex items-center border-b border-l-transparent px-3.5 py-2.5 sm:border-l sm:px-5"
  >
    <!-- Select-all checkbox in the mailbox list; All Inboxes has no selection. -->
    <slot name="lead" />

    <!-- The filter chips stand where the filter selector goes, scrolling sideways when the list
         column is too narrow for them rather than running under the buttons at the row's end. Only
         the slot's own content sits in the scroller; the selector and the plain titles don't. -->
    <div
      v-if="$slots.filter"
      ref="scroller"
      class="-my-1 flex min-w-0 flex-1 items-center overflow-x-auto py-1 [scrollbar-width:none]"
      :class="fade"
    >
      <slot name="filter" />
    </div>
    <template v-else>
      <Dropdown v-if="showFilter" :options="filterOptions">
        <button
          class="text-ink-gray-8 hover:bg-surface-gray-2 -ml-2 flex min-w-0 items-center gap-1 rounded-4 px-2 py-1"
        >
          <span class="truncate">{{ title }}</span>
          <ChevronDown class="text-ink-gray-5 icon shrink-0" />
        </button>
      </Dropdown>
      <!-- Not every title is the filter's: a selection count and a search result count
		     both land here, and neither opens a menu. -->
      <p v-else class="pb-0.5">{{ title }}</p>
    </template>

    <div class="-mr-1.5 ml-auto flex shrink-0 items-center space-x-2 pl-2">
      <!-- The caller's actions come first, so Refresh keeps the far end whatever they are and
			     nothing shifts as they come and go (an Inbox tab's own menu, say). -->
      <slot name="actions" />
      <!-- Hides while rows are selected, where the slot's bulk actions take the
			     cluster over: refreshing mid-selection would drop the selection. -->
      <template v-if="showActions">
        <Button
          variant="ghost"
          :tooltip="__('Refresh')"
          :disabled="fetching"
          @click="emit('refresh')"
        >
          <template #icon>
            <RefreshCw class="icon" />
          </template>
        </Button>
      </template>
    </div>

    <!-- Subtle loading bar: a segment sliding across the bottom outline (no layout shift) -->
    <LoadingBar v-if="loading" />
  </div>
</template>

<script setup lang="ts">
import { Button, Dropdown } from 'frappe-ui'
import { ChevronDown, RefreshCw } from 'lucide-vue-next'

import LoadingBar from '@/apps/mail/components/LoadingBar.vue'
import { useOverflowFade } from '@/apps/mail/composables/useOverflowFade'
import { useScreenSize } from '@/apps/mail/utils/composables'
import type { FilterOption } from '@/apps/mail/utils/listFilter'
import AdaptiveDropdown from '@/components/AdaptiveDropdown.vue'

// The row above the list, shared by the mailbox list and the merged All Inboxes list:
// filter selector on the left, Split View and Refresh on the right. The two lists differ
// only in what they add — a select-all checkbox and bulk actions — so those arrive
// through slots rather than as another copy of the row.

const {
  title,
  filterOptions,
  showFilter = true,
  showActions = true,
  fetching = false,
  loading = false,
} = defineProps<{
  /** What the selector reads: usually the filter's name, sometimes a count. */
  title: string
  filterOptions: FilterOption[]
  /** False renders the title as plain text — no menu to open. */
  showFilter?: boolean
  /** False hands the right-hand cluster entirely to the `actions` slot. */
  showActions?: boolean
  fetching?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{ refresh: [] }>()

const { isMobile } = useScreenSize()
// Fades the filter area's cut-off end while it scrolls.
const { scroller, fade } = useOverflowFade()
</script>
