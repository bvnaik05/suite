<script setup lang="ts">
import { Avatar, Button, TabButtons, Textarea, TextInput } from 'frappe-ui'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import {
  DriveCommentAuthor,
  GUEST_NAME_LIMIT,
  useDriveGuestName,
  type DocumentThread,
} from '@/apps/drive'
import type { ThreadPlaces } from '@/apps/writer/collab/highlights'
import { confirm, toast } from '@/platform/feedback'

import CommentDraftCard from './CommentDraftCard.vue'
import { threadRows } from './threadRows'
import type { ShownDraft, useCommentDrafts } from './useCommentDrafts'
import type { ThreadActions } from './useDocumentPanel'
import { dayOrTime } from './versionDates'

type ThreadComment = DocumentThread['comments'][number]
type CommentTab = 'open' | 'resolved'

const RESOLVED_MESSAGE_MS = 5000

/**
 * The document's comment threads under Open and Resolved tabs, one row each and
 * one open at a time. A closed row shows who started the thread, where it is,
 * when, its first comment and how many replies it has.
 */
const props = defineProps<{
  threads: DocumentThread[]
  /** Where each thread shows in the editor; null when the editor can't tell. */
  places: ThreadPlaces | null
  canComment: boolean
  actions: ThreadActions
  /** Comments on text not posted yet; only the collaborative editor makes them. */
  drafts?: ReturnType<typeof useCommentDrafts>
}>()

/** The thread shown open; its text in the editor stays lit. */
const openThread = defineModel<string | null>('openThread', { default: null })
/** The closed thread whose row is pointed at, whose text lights faintly. */
const litThread = defineModel<string | null>('litThread', { default: null })

const tab = ref<CommentTab>('open')
const rowItems = ref<HTMLElement[]>([])
const isWritingOnDocument = ref(false)
const documentText = ref('')
const documentBox = ref<{ focus(): void } | null>(null)
const replyBoxes = ref<{ focus(): void }[]>([])
/** A reply typed into each thread, kept while another is open. */
const replyTexts = ref<Record<string, string>>({})
const isReplyFocused = ref(false)
/** Threads being resolved or reopened, faded until they leave the tab. */
const leavingThreads = ref(new Set<string>())
let isSendingReply = false

// Guests may sign their comments. Signed-in users never see the field (spec §10.5)
const {
  shown: showGuestName,
  text: guestName,
  atLimit: guestNameAtLimit,
  maxLength: guestNameMaxLength,
  take: takeGuestName,
} = useDriveGuestName()

const rows = computed(() => threadRows(props.threads, props.places))
const openRows = computed(() => rows.value.filter(({ thread }) => !thread.resolved))
const resolvedRows = computed(() => rows.value.filter(({ thread }) => thread.resolved))
const isOpenTab = computed(() => tab.value === 'open')
const tabs = computed(() => [
  { label: `Open ${openRows.value.length}`, value: 'open' },
  { label: `Resolved ${resolvedRows.value.length}`, value: 'resolved' },
])
const shownRows = computed(() => {
  if (isOpenTab.value) {
    return openRows.value
  }

  return resolvedRows.value
})
const shownDrafts = computed(() => props.drafts?.drafts.value ?? [])
const canStartComment = computed(() => isOpenTab.value && props.canComment)
const hasShownDrafts = computed(() => isOpenTab.value && !!shownDrafts.value.length)
const isEmpty = computed(() => !shownRows.value.length && !hasShownDrafts.value)
const emptyText = computed(() => {
  if (!isOpenTab.value) {
    return 'No resolved comments.'
  }

  if (!props.canComment) {
    return 'No open comments.'
  }

  return 'No open comments. Select text and press Comment, or comment on the whole document above.'
})
const isDocumentBlank = computed(() => !documentText.value.trim())
const replyText = computed({
  get: () => replyTexts.value[openThread.value ?? ''] ?? '',
  set: (text: string) => {
    if (openThread.value) {
      replyTexts.value[openThread.value] = text
    }
  },
})
const hasReplyText = computed(() => !!replyText.value.trim())
const isReplyHintShown = computed(() => isReplyFocused.value && !replyText.value)
const canReply = computed(() => isOpenTab.value && props.canComment)
const guestNameHint = computed(() => {
  if (guestNameAtLimit.value) {
    return `Names can have up to ${GUEST_NAME_LIMIT} characters.`
  }

  return 'Optional. Shown with your comments.'
})

function isOpen(thread: DocumentThread) {
  return openThread.value === thread.name
}

// Opened from the list, the thread's reply box takes the cursor
async function toggleThread(thread: DocumentThread) {
  if (isOpen(thread)) {
    closeThread()
    return
  }

  openThread.value = thread.name
  await nextTick()
  replyBoxes.value[0]?.focus()
}

function closeThread() {
  openThread.value = null
}

function lightThread(thread: DocumentThread) {
  litThread.value = thread.name
}

function dimThread() {
  litThread.value = null
}

// A thread opened from its text shows under its own tab, in view
async function showOpenThread(name: string | null) {
  const row = rows.value.find(({ thread }) => thread.name === name)
  if (!row) {
    return
  }

  tab.value = row.thread.resolved ? 'resolved' : 'open'
  await nextTick()
  const item = rowItems.value.find((element) => element.dataset.thread === name)
  item?.scrollIntoView({ block: 'nearest' })
}

watch(openThread, showOpenThread, { immediate: true })

// A closed panel leaves no text lit
onBeforeUnmount(() => {
  closeThread()
  dimThread()
})

// Asks only when words would be lost
async function canDiscard(text: string) {
  if (!text.trim()) {
    return true
  }

  return confirm({
    title: 'Discard comment?',
    message: "It hasn't been posted, and can't be brought back.",
    confirmLabel: 'Discard',
    destructive: true,
  })
}

async function startDocumentComment() {
  tab.value = 'open'
  isWritingOnDocument.value = true
  await nextTick()
  documentBox.value?.focus()
}

async function stopDocumentComment() {
  if (await canDiscard(documentText.value)) {
    isWritingOnDocument.value = false
    documentText.value = ''
  }
}

async function submitDocumentComment() {
  const text = documentText.value.trim()
  if (!text) {
    return
  }

  if (await props.actions.addComment(text, takeGuestName())) {
    isWritingOnDocument.value = false
    documentText.value = ''
  }
}

function writeDraft(draft: ShownDraft, text: string) {
  props.drafts?.write(draft, text)
}

function postDraft(draft: ShownDraft) {
  void props.drafts?.post(draft, takeGuestName())
}

async function discardDraft(draft: ShownDraft) {
  if (await canDiscard(draft.text)) {
    props.drafts?.discard(draft)
  }
}

async function submitReply(thread: DocumentThread) {
  const text = replyText.value.trim()
  if (!text || isSendingReply) {
    return
  }

  isSendingReply = true
  try {
    if (await props.actions.reply(thread.name, text, takeGuestName())) {
      replyTexts.value[thread.name] = ''
    }
  } finally {
    isSendingReply = false
  }
}

function showReplyHint() {
  isReplyFocused.value = true
}

function hideReplyHint() {
  isReplyFocused.value = false
}

// Shift+Enter and a word still being composed stay in the box
function sendOnEnter(event: KeyboardEvent, thread: DocumentThread) {
  if (event.shiftKey || event.isComposing) {
    return
  }

  event.preventDefault()
  void submitReply(thread)
}

function offerUndoResolve(thread: DocumentThread) {
  toast.success('Comment resolved', {
    duration: RESOLVED_MESSAGE_MS,
    action: { label: 'Undo', onClick: () => void props.actions.resolve(thread.name, false) },
  })
}

// A thread leaves the tab it is in, so it closes and fades until it has gone
async function toggleResolved(thread: DocumentThread) {
  if (leavingThreads.value.has(thread.name)) {
    return
  }

  const isResolving = !thread.resolved
  closeThread()
  leavingThreads.value.add(thread.name)
  const isChanged = await props.actions.resolve(thread.name, isResolving)
  leavingThreads.value.delete(thread.name)
  if (isChanged && isResolving) {
    offerUndoResolve(thread)
  }
}

function resolveLabel(thread: DocumentThread) {
  if (thread.resolved) {
    return 'Reopen'
  }

  return 'Resolve'
}

function resolveIcon(thread: DocumentThread) {
  if (thread.resolved) {
    return 'lucide-rotate-ccw'
  }

  return 'lucide-check'
}

function actionsClass(thread: DocumentThread) {
  if (isOpen(thread)) {
    return ''
  }

  return 'invisible group-hover:visible group-focus-within:visible'
}

async function deleteComment(comment: ThreadComment) {
  const isConfirmed = await confirm({
    title: 'Delete comment?',
    message: "It can't be brought back.",
    confirmLabel: 'Delete',
    destructive: true,
  })
  if (isConfirmed) {
    await props.actions.removeComment(comment.name)
  }
}

function authorImage(comment: ThreadComment) {
  return comment.person?.user_image ?? undefined
}

function authorLabel(comment: ThreadComment) {
  return comment.person?.full_name || comment.author || 'Someone'
}

function firstComment(thread: DocumentThread) {
  return thread.comments[0]
}

function replies(thread: DocumentThread) {
  return thread.comments.slice(1)
}

function repliesLabel(thread: DocumentThread) {
  const count = replies(thread).length
  if (count === 1) {
    return '1 reply'
  }

  return `${count} replies`
}

defineExpose({ startDocumentComment })

function rowClass(thread: DocumentThread) {
  if (leavingThreads.value.has(thread.name)) {
    return 'pointer-events-none opacity-0'
  }

  if (isOpen(thread)) {
    return 'bg-surface-gray-1'
  }

  return 'hover:bg-surface-gray-1'
}
</script>

<template>
  <div class="space-y-3" @keydown.esc="closeThread">
    <TabButtons v-model="tab" :options="tabs" aria-label="Show comments" />
    <template v-if="canStartComment">
      <TextInput
        v-if="showGuestName"
        v-model="guestName"
        label="Your name"
        placeholder="Guest"
        autocomplete="name"
        :maxlength="guestNameMaxLength"
        :description="guestNameHint"
      />
      <form
        v-if="isWritingOnDocument"
        class="space-y-2 rounded bg-surface-gray-1 p-3"
        @submit.prevent="submitDocumentComment"
      >
        <Textarea
          ref="documentBox"
          v-model="documentText"
          :rows="2"
          placeholder="Comment on the whole document"
          aria-label="New comment"
          @keydown.esc.stop.prevent="stopDocumentComment"
        />
        <div class="flex justify-end gap-1">
          <Button size="sm" variant="ghost" label="Cancel" @click="stopDocumentComment" />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            label="Comment"
            :disabled="isDocumentBlank"
          />
        </div>
      </form>
      <button
        v-else
        type="button"
        class="block w-full rounded px-3 py-1.5 text-left text-sm text-ink-gray-5 hover:bg-surface-gray-1"
        @click="startDocumentComment"
      >
        Comment on the whole document…
      </button>
    </template>
    <section v-if="hasShownDrafts" class="space-y-2" aria-label="Not posted yet">
      <h3 class="text-sm-medium text-ink-gray-5">Not posted yet</h3>
      <CommentDraftCard
        v-for="draft in shownDrafts"
        :key="draft.clientId"
        :draft
        @write="writeDraft(draft, $event)"
        @post="postDraft(draft)"
        @discard="discardDraft(draft)"
      />
    </section>
    <ul class="space-y-1">
      <li
        v-for="{ thread, quote, where } in shownRows"
        ref="rowItems"
        :key="thread.name"
        :data-thread="thread.name"
        class="group relative rounded transition-opacity duration-200"
        :class="rowClass(thread)"
        @mouseenter="lightThread(thread)"
        @mouseleave="dimThread"
      >
        <button
          type="button"
          class="block w-full space-y-1 px-3 py-2 text-left"
          :aria-expanded="isOpen(thread)"
          @click="toggleThread(thread)"
        >
          <span class="flex items-center gap-1.5 pr-16 text-xs text-ink-gray-5">
            <span class="min-w-0 text-sm-medium text-ink-gray-8">
              <DriveCommentAuthor
                :author="firstComment(thread).author"
                :author-name="firstComment(thread).author_name"
                >{{ authorLabel(firstComment(thread)) }}</DriveCommentAuthor
              >
            </span>
            <span v-if="where" class="shrink-0">{{ where }}</span>
            <span class="shrink-0">{{ dayOrTime(firstComment(thread)) }}</span>
          </span>
          <template v-if="isOpen(thread)">
            <span v-if="quote" class="block truncate border-l-2 pl-2 text-p-sm text-ink-gray-5">
              {{ quote }}
            </span>
            <span class="block whitespace-pre-wrap text-p-sm text-ink-gray-7">
              {{ firstComment(thread).content }}
            </span>
          </template>
          <span v-else class="flex gap-1 text-p-sm">
            <span class="truncate text-ink-gray-7">{{ firstComment(thread).content }}</span>
            <span v-if="replies(thread).length" class="shrink-0 text-ink-gray-5">
              · {{ repliesLabel(thread) }}
            </span>
          </span>
        </button>
        <div
          v-if="canComment"
          class="absolute right-1 top-1 flex items-center"
          :class="actionsClass(thread)"
        >
          <Button
            v-if="isOpen(thread)"
            size="sm"
            variant="ghost"
            icon="lucide-trash-2"
            aria-label="Delete comment"
            @click="deleteComment(firstComment(thread))"
          />
          <Button
            size="sm"
            variant="ghost"
            :icon="resolveIcon(thread)"
            :aria-label="resolveLabel(thread)"
            @click="toggleResolved(thread)"
          />
        </div>
        <template v-if="isOpen(thread)">
          <div class="space-y-2 px-3 pb-3">
            <div v-for="comment in replies(thread)" :key="comment.name" class="space-y-1">
              <p class="flex items-center gap-2 text-sm-medium text-ink-gray-8">
                <Avatar
                  v-if="comment.person"
                  :image="authorImage(comment)"
                  :label="comment.person.full_name"
                  size="sm"
                  shape="circle"
                />
                <DriveCommentAuthor :author="comment.author" :author-name="comment.author_name">{{
                  authorLabel(comment)
                }}</DriveCommentAuthor>
                <span class="flex-1 text-xs text-ink-gray-5">{{ dayOrTime(comment) }}</span>
                <Button
                  v-if="canComment"
                  size="sm"
                  variant="ghost"
                  icon="lucide-trash-2"
                  aria-label="Delete comment"
                  @click="deleteComment(comment)"
                />
              </p>
              <p class="whitespace-pre-wrap text-p-sm text-ink-gray-7">{{ comment.content }}</p>
            </div>
            <form v-if="canReply" class="space-y-1" @submit.prevent="submitReply(thread)">
              <div class="relative">
                <Textarea
                  ref="replyBoxes"
                  v-model="replyText"
                  :rows="1"
                  placeholder="Reply"
                  aria-label="Reply"
                  @keydown.enter="sendOnEnter($event, thread)"
                  @focus="showReplyHint"
                  @blur="hideReplyHint"
                />
                <Button
                  v-if="hasReplyText"
                  type="submit"
                  class="absolute bottom-1 right-1"
                  size="sm"
                  variant="ghost"
                  icon="lucide-arrow-up"
                  aria-label="Send reply"
                />
              </div>
              <p v-if="isReplyHintShown" class="text-p-xs text-ink-gray-5">
                Enter to send · Shift+Enter for a new line
              </p>
            </form>
          </div>
        </template>
      </li>
    </ul>
    <p v-if="isEmpty" class="px-3 text-p-sm text-ink-gray-5">{{ emptyText }}</p>
  </div>
</template>
