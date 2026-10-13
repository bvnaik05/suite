<script setup lang="ts">
import { EditorContent, type Editor } from '@tiptap/vue-3'
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue'

import { DOCUMENT_MEDIA } from '@/apps/writer/extensions/drive-media'
import {
  editorColumns,
  editorTextStyle,
  type LayoutSettings,
} from '@/apps/writer/utils/editor-layout'
import { previewEditor } from '@/apps/writer/utils/preview-editor'

import type { RecoveryCopy } from './copies'

/** A recovery copy, read-only in Writer's typography. It is never merged into the document. */
const props = defineProps<{ copy: RecoveryCopy; settings: LayoutSettings }>()

const media = inject(DOCUMENT_MEDIA, null)

const editor = shallowRef<Editor | null>(null)
const failed = ref(false)
const shownEditor = computed(() => editor.value ?? undefined)

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
  <div class="min-w-0 flex-1 overflow-y-auto overflow-x-hidden md:border-l border-outline-gray-2">
    <div
      class="min-h-full flex flex-col md:grid md:grid-rows-[1fr]"
      :style="editorColumns(settings)"
    >
      <div class="hidden md:block" />
      <p v-if="failed" class="px-5 pt-10 text-center text-p-sm text-ink-gray-6">
        This copy can't be shown.
      </p>
      <EditorContent
        v-else
        :editor="shownEditor"
        aria-label="Recovery copy"
        class="flex grow flex-col"
        :style="editorTextStyle(settings)"
      />
    </div>
  </div>
</template>
