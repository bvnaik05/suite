<script setup lang="ts">
import { Button, Skeleton } from 'frappe-ui'
import { List, ListCell, ListHeader, ListHeaderCell, ListRow } from 'frappe-ui/list'
import { computed, onMounted, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  driveDocumentIcon,
  driveNodeRoute,
  formatDriveBytes,
  formatDriveListingDate,
  loadDriveNodeSummary,
} from '@/apps/drive'
import { writerDocument } from '@/apps/writer'

import { savedAtLabel, type RecoveryCopy } from './copies'
import RecoveryCopyActions from './RecoveryCopyActions.vue'
import RecoveryPreview from './RecoveryPreview.vue'
import { useRecoveryCopies } from './useRecoveryCopies'

/** Every Writer copy this device keeps, also of documents the person can no longer open. */
const { copies, refresh } = useRecoveryCopies()
const route = useRoute()
const router = useRouter()

const isLoading = shallowRef(true)
const showsSkeleton = shallowRef(false)
// Drive's placeholder look and delay, so a fast read shows nothing
const SKELETON_BAR = '!bg-surface-gray-2 motion-reduce:animate-none'
const SKELETON_NAMES = ['w-40', 'w-28', 'w-52']
const SKELETON_DELAY = 180
// Drive's order: nothing for a fast read, placeholder rows for a slow one, then the list
const isBlank = computed(() => isLoading.value && !showsSkeleton.value)
const isPlaceholder = computed(() => isLoading.value && showsSkeleton.value)
const hasNoCopies = computed(() => !isLoading.value && !copies.value.length)
// Drive's listing tracks; a phone drops the saved time, as Drive drops Modified
const COLUMNS = {
  base: ['minmax(0,1fr)', '6rem', '2.5rem'],
  md: ['minmax(0,1fr)', '6rem', '8rem', '2.5rem'],
}
const icon = driveDocumentIcon(writerDocument.contentDoctype)
// A copy whose document can't be opened shows on this page instead
const shownCopy = computed(() => copies.value.find((copy) => copy.key === route.query.copy))

onMounted(async () => {
  const skeletonTimer = setTimeout(showSkeleton, SKELETON_DELAY)
  await refresh()
  clearTimeout(skeletonTimer)
  isLoading.value = false
})

function showSkeleton() {
  showsSkeleton.value = true
}

async function view(copy: RecoveryCopy) {
  const node = await loadDriveNodeSummary(copy.node).catch(() => null)
  if (node && node.state !== 'Trashed') {
    await router.push({ ...driveNodeRoute(node), query: { recovery: copy.key } })
    return
  }

  await router.push({ query: { copy: copy.key } })
}

async function discarded() {
  await refresh()
  if (route.query.copy) {
    await router.push({ query: {} })
  }
}

function titleOf(copy: RecoveryCopy) {
  return copy.title || 'Untitled document'
}

function savedAt(copy: RecoveryCopy) {
  return formatDriveListingDate(copy.savedAt.toISOString())
}

function details(copy: RecoveryCopy) {
  const size = formatDriveBytes(copy.size)
  const savedAt = savedAtLabel(copy)
  return `${savedAt} · ${size}`
}
</script>

<template>
  <article v-if="shownCopy" aria-labelledby="shown-copy" class="space-y-2">
    <header class="flex items-center gap-2">
      <Button
        icon="lucide-arrow-left"
        variant="ghost"
        aria-label="All copies"
        @click="router.push({ query: {} })"
      />
      <div class="min-w-0 flex-1">
        <h2 id="shown-copy" class="truncate text-base-medium text-ink-gray-8">
          {{ titleOf(shownCopy) }}
        </h2>
        <p class="text-xs text-ink-gray-5">{{ details(shownCopy) }}</p>
      </div>
      <RecoveryCopyActions :copy="shownCopy" @discarded="discarded" />
    </header>
    <div class="flex rounded border border-outline-gray-2">
      <RecoveryPreview :copy="shownCopy" :settings="null" />
    </div>
  </article>
  <div v-else-if="isBlank" aria-busy="true" />
  <div
    v-else-if="hasNoCopies"
    class="flex flex-col items-center justify-center gap-2 py-16 text-center"
  >
    <span class="lucide-folder-open size-6 text-ink-gray-4" aria-hidden="true" />
    <p class="text-base text-ink-gray-5">No recovery copies</p>
    <p class="text-p-sm text-ink-gray-5">
      Changes that couldn't be saved stay here, on this device, until you discard them.
    </p>
  </div>
  <List
    v-else
    :columns="COLUMNS"
    :row-height="40"
    class="-mx-3 list-row-px-3"
    :aria-busy="isPlaceholder"
  >
    <ListHeader>
      <ListHeaderCell class="text-sm-medium text-ink-gray-5">Name</ListHeaderCell>
      <ListHeaderCell class="justify-end text-sm-medium text-ink-gray-5">Size</ListHeaderCell>
      <ListHeaderCell class="hidden justify-end text-sm-medium text-ink-gray-5 md:flex">
        Saved
      </ListHeaderCell>
      <ListHeaderCell><span class="sr-only">Actions</span></ListHeaderCell>
    </ListHeader>
    <template v-if="isPlaceholder">
      <ListRow v-for="(width, index) in SKELETON_NAMES" :key="index" aria-hidden="true">
        <ListCell>
          <Skeleton class="mr-2 size-4 shrink-0 rounded-1" :class="SKELETON_BAR" />
          <Skeleton class="h-2 max-w-full rounded-full" :class="[SKELETON_BAR, width]" />
        </ListCell>
        <ListCell />
        <ListCell class="hidden justify-end md:flex">
          <Skeleton class="h-2 w-14 rounded-full" :class="SKELETON_BAR" />
        </ListCell>
        <ListCell />
      </ListRow>
    </template>
    <template v-else>
      <ListRow
        v-for="copy in copies"
        :key="copy.key"
        :value="copy.key"
        tabindex="0"
        class="select-none"
        @click="view(copy)"
      >
        <ListCell>
          <span class="mr-2 size-4 shrink-0" :class="icon" aria-hidden="true" />
          <span class="min-w-0 truncate text-base text-ink-gray-8" :title="titleOf(copy)">{{
            titleOf(copy)
          }}</span>
        </ListCell>
        <ListCell class="justify-end">
          <span class="truncate text-base text-ink-gray-5">{{ formatDriveBytes(copy.size) }}</span>
        </ListCell>
        <ListCell class="hidden justify-end md:flex">
          <span class="truncate text-base text-ink-gray-5">{{ savedAt(copy) }}</span>
        </ListCell>
        <ListCell class="justify-end">
          <RecoveryCopyActions :copy="copy" can-view @view="view(copy)" @discarded="refresh" />
        </ListCell>
      </ListRow>
    </template>
  </List>
</template>
