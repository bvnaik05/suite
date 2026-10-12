<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { formatDriveBytes } from '@/apps/drive'

import { savedAtLabel, type RecoveryCopy } from './copies'
import RecoveryCopyActions from './RecoveryCopyActions.vue'
import { useRecoveryCopies } from './useRecoveryCopies'

/** Every Writer copy this device keeps, also of documents the person can no longer open. */
const { copies, refresh } = useRecoveryCopies()

const hasNoCopies = computed(() => !copies.value.length)

onMounted(refresh)

function titleOf(copy: RecoveryCopy) {
  return copy.title || 'Untitled document'
}

function details(copy: RecoveryCopy) {
  const size = formatDriveBytes(copy.size)
  const savedAt = savedAtLabel(copy)
  return `${savedAt} · ${size}`
}
</script>

<template>
  <section aria-labelledby="unsaved-writer" class="space-y-2">
    <h2 id="unsaved-writer" class="text-base-medium text-ink-gray-8">Documents</h2>
    <p v-if="hasNoCopies" class="text-sm text-ink-gray-5">No unsaved documents on this device.</p>
    <ul v-else class="divide-y divide-outline-gray-1">
      <li
        v-for="copy in copies"
        :key="copy.key"
        class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
      >
        <div class="min-w-0">
          <p class="truncate text-sm-medium text-ink-gray-8">{{ titleOf(copy) }}</p>
          <p class="text-xs text-ink-gray-5">{{ details(copy) }}</p>
        </div>
        <RecoveryCopyActions :copy="copy" @discarded="refresh" />
      </li>
    </ul>
  </section>
</template>
