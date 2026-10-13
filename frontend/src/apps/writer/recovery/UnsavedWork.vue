<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { formatDriveBytes } from '@/apps/drive'

import { savedAtLabel, type RecoveryCopy } from './copies'
import RecoveryCopyActions from './RecoveryCopyActions.vue'
import RecoveryCopyView from './RecoveryCopyView.vue'
import { useRecoveryCopies } from './useRecoveryCopies'

/** Every Writer copy this device keeps, also of documents the person can no longer open. */
const { copies, refresh } = useRecoveryCopies()

const hasNoCopies = computed(() => !copies.value.length)
const viewed = ref<RecoveryCopy | null>(null)
const isViewing = ref(false)

onMounted(refresh)

function view(copy: RecoveryCopy) {
  viewed.value = copy
  isViewing.value = true
}

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
        class="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-gray-2"
      >
        <button
          type="button"
          class="min-w-0 flex-1 py-1 text-start focus-visible:focus-ring"
          @click="view(copy)"
        >
          <span class="block truncate text-sm-medium text-ink-gray-8">{{ titleOf(copy) }}</span>
          <span class="block text-xs text-ink-gray-5">{{ details(copy) }}</span>
        </button>
        <RecoveryCopyActions :copy="copy" @discarded="refresh" />
      </li>
    </ul>
    <RecoveryCopyView v-if="viewed" v-model:open="isViewing" :copy="viewed" />
  </section>
</template>
