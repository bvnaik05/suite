<script setup lang="ts">
import { Button } from 'frappe-ui'
import { onMounted, ref } from 'vue'

import { savedAtLabel, type RecoveryCopy } from './copies'
import RecoveryCopyActions from './RecoveryCopyActions.vue'
import RecoveryCopyView from './RecoveryCopyView.vue'
import { useRecoveryCopies } from './useRecoveryCopies'

/** One line per copy of this document kept on this device, until the person discards it. */
const props = defineProps<{ node: string }>()

const { copies, refresh } = useRecoveryCopies(props.node)

const viewed = ref<RecoveryCopy | null>(null)
const isViewing = ref(false)

onMounted(refresh)

function view(copy: RecoveryCopy) {
  viewed.value = copy
  isViewing.value = true
}

defineExpose({ refresh })
</script>

<template>
  <div
    v-for="copy in copies"
    :key="copy.key"
    class="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-outline-gray-1 bg-surface-gray-2 px-5 py-1 text-sm text-ink-gray-7"
    role="status"
  >
    <p>This device has unsaved work from {{ savedAtLabel(copy) }}</p>
    <div class="flex shrink-0 items-center gap-1">
      <Button size="sm" variant="subtle" label="View" @click="view(copy)" />
      <RecoveryCopyActions :copy="copy" @discarded="refresh" />
    </div>
  </div>
  <RecoveryCopyView v-if="viewed" v-model:open="isViewing" :copy="viewed" />
</template>
