<script setup lang="ts">
import { Button } from 'frappe-ui'
import { onMounted } from 'vue'

import { savedAtLabel, type RecoveryCopy } from './copies'
import { useRecoveryCopies } from './useRecoveryCopies'

/** One line per copy of this document kept on this device, until the person discards it. */
const props = defineProps<{ node: string }>()
defineEmits<{ view: [copy: RecoveryCopy] }>()

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
    <Button size="sm" variant="subtle" label="View" @click="$emit('view', copy)" />
  </div>
</template>
