<script setup lang="ts">
import { Dialog } from 'frappe-ui'
import { computed } from 'vue'

import type { RecoveryCopy } from './copies'

/** Shows a recovery copy read-only. */
const props = defineProps<{ copy: RecoveryCopy }>()
const open = defineModel<boolean>('open', { required: true })

const viewTitle = computed(() => props.copy.title || 'Untitled document')
// Follows the viewer's light or dark scheme, since the copy carries no styles of its own
const viewedPage = computed(() => {
  const style = '<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}</style>'
  return `${style}${props.copy.html}`
})
</script>

<template>
  <Dialog v-model:open="open" :title="viewTitle" size="3xl">
    <iframe
      sandbox=""
      title="Recovery copy"
      class="h-[60vh] w-full rounded-4 border border-outline-gray-2"
      :srcdoc="viewedPage"
    />
  </Dialog>
</template>
