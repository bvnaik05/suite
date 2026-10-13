<script setup lang="ts">
import { Button } from 'frappe-ui'
import { computed, onMounted } from 'vue'

import { savedAtLabel, type RecoveryCopy } from './copies'
import { useRecoveryCopies } from './useRecoveryCopies'

/** The latest copy of this document kept on this device; older ones are listed on their own page. */
const props = defineProps<{ node: string }>()
defineEmits<{ view: [copy: RecoveryCopy] }>()

const { copies, refresh } = useRecoveryCopies(props.node)
const latest = computed(() => copies.value[0])

onMounted(refresh)

defineExpose({ refresh })
</script>

<template>
  <div
    v-if="latest"
    class="flex shrink-0 items-center gap-2 border-b border-outline-gray-1 bg-surface-blue-2 px-5 py-1 text-sm text-ink-blue-7"
    role="status"
  >
    <span class="lucide-history size-4 shrink-0" aria-hidden="true" />
    <p class="min-w-0 flex-1">This device has unsaved work from {{ savedAtLabel(latest) }}</p>
    <Button size="sm" variant="ghost" theme="blue" label="View" @click="$emit('view', latest)" />
  </div>
</template>
