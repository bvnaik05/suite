<script setup lang="ts">
import type { Editor } from '@tiptap/vue-3'
import { inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue'

import PreviewPane from '@/apps/writer/components/PreviewPane.vue'
import { DOCUMENT_MEDIA } from '@/apps/writer/extensions/drive-media'
import type { LayoutSettings } from '@/apps/writer/utils/editor-layout'
import { previewEditor } from '@/apps/writer/utils/preview-editor'

import type { RecoveryCopy } from './copies'

/** A recovery copy, read-only in Writer's typography. It is never merged into the document. */
const props = defineProps<{ copy: RecoveryCopy; settings: LayoutSettings }>()

const media = inject(DOCUMENT_MEDIA, null)

const editor = shallowRef<Editor | null>(null)
const failed = ref(false)

function showCopy() {
  editor.value?.destroy()
  failed.value = false
  editor.value = previewEditor(props.copy.html, media, () => {
    failed.value = true
  })
}

watch(() => props.copy.key, showCopy, { immediate: true })

onBeforeUnmount(() => editor.value?.destroy())
</script>

<template>
  <PreviewPane :editor="editor" :settings="settings" label="Recovery copy" :is-failed="failed">
    <template #failed>This copy can't be shown.</template>
  </PreviewPane>
</template>
