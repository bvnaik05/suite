<script setup lang="ts">
import { onMounted } from 'vue'

import { savedAtLabel } from './copies'
import RecoveryCopyActions from './RecoveryCopyActions.vue'
import { useRecoveryCopies } from './useRecoveryCopies'

/** One line per copy of this document kept on this device, until the person discards it. */
const props = defineProps<{ node: string }>()

const { copies, refresh } = useRecoveryCopies(props.node)

onMounted(refresh)

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
    <RecoveryCopyActions :copy="copy" @discarded="refresh" />
  </div>
</template>
