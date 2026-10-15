<script setup lang="ts">
import { Avatar, Button, TabButtons, Textarea, TextInput } from 'frappe-ui'
import { computed, nextTick, ref } from 'vue'

import {
  DriveCommentAuthor,
  GUEST_NAME_LIMIT,
  useDriveGuestName,
  type DocumentThread,
} from '@/apps/drive'
import type { ThreadPlaces } from '@/apps/writer/collab/highlights'
import { confirm } from '@/platform/feedback'

import CommentDraftCard from './CommentDraftCard.vue'
import { threadRows } from './threadRows'
import type { ShownDraft, useCommentDrafts } from './useCommentDrafts'
import type { ThreadActions } from './useDocumentPanel'
import { dayOrTime } from './versionDates'

type ThreadComment = DocumentThread['comments'][number]
type CommentTab = 'open' | 'resolved'

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

const tab = ref<CommentTab>('open')
const openThread = ref<string | null>(null)
const isWritingOnDocument = ref(false)
const documentText = ref('')
const documentBox = ref<{ focus(): void } | null>(null)
const replyingTo = ref<string | null>(null)
const replyText = ref('')

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
const isReplyBlank = computed(() => !replyText.value.trim())
const guestNameHint = computed(() => {
  if (guestNameAtLimit.value) {
    return `Names can have up to ${GUEST_NAME_LIMIT} characters.`
  }

  return 'Optional. Shown with your comments.'
})

function isOpen(thread: DocumentThread) {
  return openThread.value === thread.name
}

function toggleThread(thread: DocumentThread) {
  replyingTo.value = null
  if (isOpen(thread)) {
    closeThread()
    return
  }

  openThread.value = thread.name
}

function closeThread() {
  openThread.value = null
}

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

function isReplying(thread: DocumentThread) {
  return replyingTo.value === thread.name
}

function startReply(thread: DocumentThread) {
  replyingTo.value = thread.name
  replyText.value = ''
}

async function submitReply(thread: DocumentThread) {
  const text = replyText.value.trim()
  if (!text) {
    return
  }

  if (await props.actions.reply(thread.name, text, takeGuestName())) {
    replyingTo.value = null
    replyText.value = ''
  }
}

// A thread leaves the tab it is in, so it closes
function toggleResolved(thread: DocumentThread) {
  closeThread()
  void props.actions.resolve(thread.name, !thread.resolved)
}

function resolveLabel(thread: DocumentThread) {
  if (thread.resolved) {
    return 'Reopen'
  }

  return 'Resolve'
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

function rowClass(thread: DocumentThread) {
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
        :key="thread.name"
        class="relative rounded"
        :class="rowClass(thread)"
      >
        <button
          type="button"
          class="block w-full space-y-1 px-3 py-2 text-left"
          :aria-expanded="isOpen(thread)"
          @click="toggleThread(thread)"
        >
          <span class="flex items-center gap-1.5 pr-6 text-xs text-ink-gray-5">
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
        <template v-if="isOpen(thread)">
          <Button
            v-if="canComment"
            class="absolute right-1 top-1"
            size="sm"
            variant="ghost"
            icon="lucide-trash-2"
            aria-label="Delete comment"
            @click="deleteComment(firstComment(thread))"
          />
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
            <form
              v-if="isReplying(thread)"
              class="flex gap-2"
              @submit.prevent="submitReply(thread)"
            >
              <TextInput
                v-model="replyText"
                class="flex-1"
                placeholder="Reply"
                aria-label="Reply"
              />
              <Button type="submit" label="Send" :disabled="isReplyBlank" />
            </form>
            <div v-else-if="canComment" class="flex gap-1">
              <Button size="sm" variant="ghost" label="Reply" @click="startReply(thread)" />
              <Button
                size="sm"
                variant="ghost"
                :label="resolveLabel(thread)"
                @click="toggleResolved(thread)"
              />
            </div>
          </div>
        </template>
      </li>
    </ul>
    <p v-if="isEmpty" class="px-3 text-p-sm text-ink-gray-5">{{ emptyText }}</p>
  </div>
</template>
