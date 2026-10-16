<template>
  <div class="flex flex-col w-full bg-surface-base" @keydown.capture="openCommandPalette">
    <slot name="toolbar">
      <TextEditorFixedMenu
        v-if="editable"
        class="w-full max-w-[100vw] py-1.5 !px-4 md:px-0 overflow-x-auto flex shrink-0 border-b border-outline-elevation-2"
        :editor="editor"
        :items="menuButtons"
      />
    </slot>
    <div class="flex flex-1 overflow-hidden">
      <ToC v-if="editor" :editor :anchors :class="$slots.cover && 'invisible'" />
      <div class="relative flex flex-1 min-w-0">
        <div
          v-show="!$slots.cover"
          id="editor-scroll-container"
          class="relative flex-1 min-w-0 overflow-y-auto overflow-x-hidden md:border-l border-outline-gray-2"
        >
          <div
            class="min-h-full flex flex-col md:grid md:grid-rows-[1fr]"
            :style="gridStyle"
            @click="onBackgroundClick"
          >
            <div class="hidden md:block" />
            <div class="flex flex-col grow min-w-0">
              <FTextEditor
                ref="textEditor"
                v-model="localContent"
                :upload-function="uploadFunction"
                :autofocus="true"
                placeholder="Start thinking…"
                :extensions="editorExtensions"
                :editable
                @change="handleEditorChange"
              >
                <template #default="{ editor }">
                  <BubbleMenu
                    v-if="editor"
                    :editor
                    :should-show="bubbleMenuOpts.shouldShow"
                    class="z-10"
                    data-slot="bubble-menu"
                  >
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1.5 rounded-4 border border-outline-gray-2 bg-surface-elevation-2 pl-2 pr-2.5 text-sm text-ink-gray-8 shadow-sm hover:bg-surface-gray-2"
                      @click="addComment"
                    >
                      <span class="lucide-message-square-plus size-4" aria-hidden="true" />
                      Comment
                    </button>
                  </BubbleMenu>
                  <EditorTableMenu :editor />
                  <EditorDropZone :editor :disabled="!editable" class="grow flex flex-col">
                    <EditorContent
                      :editor
                      role="textbox"
                      aria-label="Document editor"
                      aria-multiline="true"
                      :class="[EDITOR_TEXT_CLASS, isPainting && 'cursor-crosshair']"
                      :style="editorStyle"
                    />
                  </EditorDropZone>
                </template>
              </FTextEditor>
            </div>
            <div class="relative hidden md:block min-w-0">
              <FloatingComments
                v-if="commentsPainted"
                v-model:active-comment="activeComment"
                :y-comments="comments"
                :file
                :show-comments
                :show-resolved
                :show-unanchored
                :editor="editor!"
                @save="saveComments"
              />
            </div>
          </div>
        </div>
        <slot name="cover" />
        <div
          v-if="paintedComments?._map.size && !$slots.cover"
          class="hidden md:block absolute top-4 right-4"
        >
          <Dropdown :options="commentFilterOptions" align="end">
            <Button
              :icon="LucideMessageSquareQuote"
              variant="outline"
              label="Comment visibility"
              tooltip="Comment visibility"
            />
          </Dropdown>
        </div>
      </div>
      <slot name="aside" />
    </div>
    <ToCMobile v-if="editor && !$slots.cover" :editor />
  </div>
</template>

<script setup lang="ts">
import type { AnyExtension, Content } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import { onKeyDown } from '@vueuse/core'
import LucideMessageSquareQuote from '~icons/lucide/message-square-quote'
import { Button, Dropdown, toast, useFileUpload } from 'frappe-ui'
import {
  EditorContent,
  EditorDropZone,
  EditorTableMenu,
  Editor as FTextEditor,
  EditorFixedMenu as TextEditorFixedMenu,
} from 'frappe-ui/editor'
import { v4 as uuidv4 } from 'uuid'
import { computed, inject, onBeforeUnmount, provide, ref, useTemplateRef, watch } from 'vue'
import type * as Y from 'yjs'

import { hasDefaultDocumentTitle } from '@/apps/drive'
import { searchMentions, useUsers } from '@/apps/writer/composables/useUsers'
import { writerEditorExtensions } from '@/apps/writer/editor-extensions'
import emitter from '@/apps/writer/emitter'
import { rebuild } from '@/apps/writer/extensions/comments'
import { DOCUMENT_MEDIA } from '@/apps/writer/extensions/drive-media'
import { currentTabHTML } from '@/apps/writer/extensions/tabs'
import { RENAME_DOCUMENT } from '@/apps/writer/renameDocument'
import type {
  EditorFile,
  WriterDocument,
  WriterSettings,
} from '@/apps/writer/surface/writerDocument'
import { isModKey, printDoc } from '@/apps/writer/utils'
import {
  EDITOR_TEXT_CLASS,
  editorColumns,
  editorTextStyle,
} from '@/apps/writer/utils/editor-layout'
import { useSessionStore } from '@/boot/session'
import { useRootStore } from '@/stores/root'

import { bubbleMenuOptions } from './core-editor/bubble-menu'
import { buildMenuButtons } from './core-editor/menu-buttons'
import FloatingComments from './FloatingComments.vue'
import ToC from './ToC.vue'
import ToCMobile from './ToCMobile.vue'

const props = withDefaults(
  defineProps<{
    file: EditorFile
    document: WriterDocument
    settings: WriterSettings
    editable?: boolean
    collaborative?: boolean
    yjsDoc?: Y.Doc | null
    extensions?: AnyExtension[]
    comments?: Y.Map<unknown>
    newComment?: (
      id: string,
      from: number,
      to: number,
      owner: string | null,
      anchorText: string,
    ) => void
    saveComments?: () => Promise<void>
    rawContent?: string
    // Takes over the bubble menu's Comment, for editors that comment through Drive
    commentOnSelection?: (() => void) | null
  }>(),
  { yjsDoc: null, extensions: () => [], commentOnSelection: null },
)

const emit = defineEmits<{
  save: [manual: boolean, html: string | null, done?: () => void]
  'editor-change': [value: Content]
  cleanup: []
}>()

const showSettings = defineModel<boolean>('showSettings')
const edited = defineModel<boolean>('edited')
const root = useRootStore()

const localContent = ref(props.rawContent ?? '')

watch(
  () => props.rawContent,
  (val) => {
    if (val) localContent.value = val
  },
  { once: true },
)

const textEditor = useTemplateRef('textEditor')
const editor = computed(() => textEditor.value?.editor)
provide('editor', editor)
defineExpose({ editor })

const anchors = ref<unknown[]>([])
const activeComment = ref<string | null>(null)
const commentsPainted = ref(false)
const showComments = ref<boolean>(JSON.parse(localStorage.getItem('show-comments') || 'false'))
const showResolved = ref(false)
const showUnanchored = ref(false)

// The comments map, once its extension has painted it
const paintedComments = computed(() => {
  if (!commentsPainted.value) {
    return undefined
  }

  return props.comments
})

watch(activeComment, () => rebuild(editor.value))
watch(showComments, (isShown) => localStorage.setItem('show-comments', String(isShown)))

const scrollParent = computed(() => document.querySelector<HTMLElement>('#editor-scroll-container'))

// The format painter keeps its flag in plain editor storage, which Vue does
// not track. Read it again after each transaction.
const isPainting = ref(false)

watch(
  editor,
  (instance, _previous, onCleanup) => {
    if (!instance) return
    const read = () => (isPainting.value = !!instance.storage.styleClipboard?.painting)
    instance.on('transaction', read)
    onCleanup(() => instance.off('transaction', read))
  },
  { immediate: true },
)

const showUnanchoredButton = computed(() => {
  const comments = paintedComments.value
  if (!comments) {
    return false
  }

  return Array.from(comments._map).some(([, value]) => {
    const [first] = value.content.getContent()
    return !document.querySelector(`[data-comment-name='${first?.id}']`)
  })
})

const commentFilterOptions = computed(() => {
  const comments = paintedComments.value
  if (!comments) {
    return []
  }

  const hasResolved = Array.from(comments._map).some(([, value]) => {
    const [first] = value.content.getContent()
    return first?.resolved
  })
  return [
    {
      label: 'Comments',
      switch: true as const,
      switchValue: showComments.value,
      onClick: () => (showComments.value = !showComments.value),
    },
    hasResolved &&
      showComments.value && {
        label: 'Resolved',
        switch: true as const,
        switchValue: showResolved.value,
        onClick: () => (showResolved.value = !showResolved.value),
      },
    showUnanchoredButton.value &&
      showComments.value && {
        label: 'Outdated',
        switch: true as const,
        switchValue: showUnanchored.value,
        onClick: () => (showUnanchored.value = !showUnanchored.value),
      },
  ].filter((option) => option !== false)
})

function onCommentActivated(id: string) {
  if (!id) return
  activeComment.value = id
  showComments.value = true
  const commentEl =
    document.querySelector<HTMLElement>(`span[data-comment-name="${id}"]`) ||
    document.querySelector<HTMLElement>(`span[data-comment-id="${id}"]`)
  if (commentEl && !commentEl.offsetParent) {
    commentEl.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
      inline: 'nearest',
    })
  }
}

const { users } = useUsers()
const renameDocument = inject(RENAME_DOCUMENT, null)

const writerEditorOptions = {
  collaborative: props.collaborative,
  mentionItems: () => users.value,
  onMentionQuery: searchMentions,
  onCommentActivated,
  onAnchors: (found: unknown[]) => {
    anchors.value = found
  },
  scrollParent: () => scrollParent.value!,
  media: inject(DOCUMENT_MEDIA, null),
  comments: props.comments,
  ydoc: props.yjsDoc,
  activeComment,
  showComments,
  showResolved,
  edited,
  onCommentsPainted: () => (commentsPainted.value = true),
}

const editorExtensions = [...writerEditorExtensions(writerEditorOptions), ...props.extensions]

const menuButtons = computed(() =>
  buildMenuButtons({
    editor,
    settings: props.settings,
    isPainting,
    openSettings: () => (showSettings.value = true),
  }),
)

const bubbleMenuOpts = computed(() => bubbleMenuOptions({ comments: props.comments }))

const gridStyle = computed(() => editorColumns(props.settings))

const editorStyle = computed(() => editorTextStyle(props.settings))

function uploadFunction(file: File) {
  const fileUpload = useFileUpload()
  return fileUpload.upload(file, {
    private: false,
    params: { file_id: props.file.doc.name },
    upload_endpoint: `/api/method/suite.writer.api.embed.add`,
  })
}

function onBackgroundClick(event: MouseEvent) {
  if (event.target instanceof HTMLElement && event.target.tagName === 'DIV') {
    textEditor.value?.editor?.chain?.().focus?.().run?.()
  }
}

// The owner of `edited` decides what counts as a change: `useYjs` reads the
// Yjs document, `NonCollabEditor` compares the HTML. This event also fires
// when the stored body is first put into the editor, so it marks nothing.
function handleEditorChange(value: Content) {
  emit('editor-change', value)
}

const autorename = () => {
  const { $anchor } = editor.value!.view.state.selection
  const inFirstBlock = $anchor.index(0) === 1 && $anchor.depth === 1
  if (!inFirstBlock) {
    const inLastLine =
      $anchor.depth === 1 && editor.value!.state.doc.childCount - 1 === $anchor.index(0)
    if (inLastLine) {
      scrollParent.value!.scroll(0, scrollParent.value!.scrollHeight)
    }
    return
  }
  if (!hasDefaultDocumentTitle(props.file.doc.file_name)) return

  const implicitTitle = editor
    .value!.state.doc.firstChild!.textContent.replaceAll('#', '')
    .replaceAll('@', '')
    .slice(0, 30)
    .trim()
  if (!implicitTitle.length) return

  renameDocument?.(implicitTitle.slice(0, 100)).catch((error) => {
    toast.error(error?.message || 'Could not rename this file.')
  })
}

const addComment = () => {
  if (props.commentOnSelection) {
    return props.commentOnSelection()
  }
  if (!props.yjsDoc) {
    return toast.warning("New comments aren't supported on this doc.", {
      duration: 1,
    })
  }
  showComments.value = true
  const { state } = editor.value!
  const { from, to } = state.selection
  if (from === to) return

  const id = uuidv4()
  props.newComment!(id, from, to, useSessionStore().user, state.doc.textBetween(from, to, ' '))
  activeComment.value = id
  const tr = state.tr.setSelection(TextSelection.create(state.doc, from))
  editor.value!.view.dispatch(tr)
}

function manualSave(func?: () => void) {
  emit('save', true, null, func)
}

function openCommandPalette(event: KeyboardEvent) {
  if (
    !props.editable ||
    (!event.metaKey && !event.ctrlKey) ||
    event.shiftKey ||
    event.altKey ||
    event.key.toLowerCase() !== 'k'
  )
    return
  event.preventDefault()
  event.stopPropagation()
  root.paletteOpen = true
}

onKeyDown('p', (e) => {
  if (!isModKey(e)) return
  e.preventDefault()
  emitter.emit('print-file')
})

onKeyDown('s', (e) => {
  if (!props.editable || !isModKey(e) || e.shiftKey) return
  e.preventDefault()
  manualSave(() => toast.success('Saved document'))
})

onKeyDown('Enter', autorename)

emitter.on('print-file', () => {
  if (editor.value) {
    printDoc(currentTabHTML(editor.value), props.settings)
  }
})

emitter.on('manual-save', manualSave)

onBeforeUnmount(() => {
  if (edited.value) {
    emit('save', false, editor.value!.getHTML())
  }
  emitter.off('print-file')
  emitter.off('manual-save')
  emit('cleanup')
})
</script>

<style>
@import url('@/apps/writer/styles/editor.css');

iframe {
  border: 1px solid var(--surface-gray-4) !important;
}
</style>
