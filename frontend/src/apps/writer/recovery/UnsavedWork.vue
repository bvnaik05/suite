<script setup lang="ts">
import { Button } from 'frappe-ui'
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { driveNodeRoute, formatDriveBytes, loadDriveNodeSummary } from '@/apps/drive'

import { savedAtLabel, type RecoveryCopy } from './copies'
import RecoveryCopyActions from './RecoveryCopyActions.vue'
import RecoveryPreview from './RecoveryPreview.vue'
import { useRecoveryCopies } from './useRecoveryCopies'

/** Every Writer copy this device keeps, also of documents the person can no longer open. */
const { copies, refresh } = useRecoveryCopies()
const route = useRoute()
const router = useRouter()

const hasNoCopies = computed(() => !copies.value.length)
// A copy whose document can't be opened shows on this page instead
const shownCopy = computed(() => copies.value.find((copy) => copy.key === route.query.copy))

onMounted(refresh)

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
  <section v-else aria-labelledby="unsaved-writer" class="space-y-2">
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
        <RecoveryCopyActions :copy="copy" can-view @view="view(copy)" @discarded="refresh" />
      </li>
    </ul>
  </section>
</template>
