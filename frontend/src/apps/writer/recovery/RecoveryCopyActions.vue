<script setup lang="ts">
import { Button, Dialog } from 'frappe-ui'
import { computed, ref } from 'vue'

import { confirm, toast } from '@/platform/feedback'

import { copyToClipboard, discardCopy, downloadCopy, type RecoveryCopy } from './copies'

const props = defineProps<{ copy: RecoveryCopy }>()
const emit = defineEmits<{ discarded: [] }>()

const viewing = ref(false)

const viewTitle = computed(() => props.copy.title || 'Untitled document')
// Follows the viewer's light or dark scheme, since the copy carries no styles of its own
const viewedPage = computed(() => {
  const style = '<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}</style>'
  return `${style}${props.copy.html}`
})

function view() {
  viewing.value = true
}

async function copyText() {
  try {
    await copyToClipboard(props.copy)
  } catch {
    toast.error("Couldn't copy. Download it instead.")
    return
  }

  toast.success('Copied')
}

function download() {
  downloadCopy(props.copy)
}

async function discard() {
  const isConfirmed = await confirm({
    title: 'Discard recovery copy?',
    message: "This deletes the copy from this device. It can't be brought back.",
    confirmLabel: 'Discard',
    destructive: true,
  })
  if (!isConfirmed) {
    return
  }

  await discardCopy(props.copy)
  emit('discarded')
}
</script>

<template>
  <div class="flex shrink-0 items-center gap-1">
    <Button size="sm" variant="ghost" label="View" @click="view" />
    <Button size="sm" variant="ghost" label="Copy" @click="copyText" />
    <Button size="sm" variant="ghost" label="Download" @click="download" />
    <Button size="sm" variant="ghost" theme="red" label="Discard" @click="discard" />
  </div>
  <Dialog v-model:open="viewing" :title="viewTitle" size="3xl">
    <iframe
      sandbox=""
      title="Recovery copy"
      class="h-[60vh] w-full rounded-4 border border-outline-gray-2"
      :srcdoc="viewedPage"
    />
  </Dialog>
</template>
