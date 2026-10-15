<script setup lang="ts">
import { Avatar, Button, TextInput } from 'frappe-ui'
import { computed, nextTick, ref, watch } from 'vue'

import {
  DriveCommentAuthor,
  GUEST_NAME_LIMIT,
  useDriveGuestName,
  type DocumentPanel,
  type DocumentSession,
  type DocumentThread,
  type DocumentVersion,
} from '@/apps/drive'
import type { ThreadPlaces } from '@/apps/writer/collab/highlights'
import { confirm } from '@/platform/feedback'

import CommentDraftCard from './CommentDraftCard.vue'
import { groupThreads, type ThreadGroup } from './threadGroups'
import type { ShownDraft, useCommentDrafts } from './useCommentDrafts'
import { useDocumentPanel } from './useDocumentPanel'
import VersionList from './VersionList.vue'

type ThreadComment = DocumentThread['comments'][number]

const props = defineProps<{
  session: DocumentSession
  canComment: boolean
  canRestoreVersion: boolean
  isRestoringVersion: boolean
  threads: DocumentThread[]
  /** Where each thread shows in the editor; null when the editor can't tell. */
  places: ThreadPlaces | null
  refreshThreads: () => Promise<void>
  /** Comments on text not posted yet; only the collaborative editor makes them. */
  drafts?: ReturnType<typeof useCommentDrafts>
  /** Saves the document's pending edits, throwing why it couldn't. */
  saveFirst: () => Promise<void>
}>()

const panel = defineModel<DocumentPanel | null>('panel', { required: true })
const emit = defineEmits<{
  closed: [panel: DocumentPanel]
  restoreVersion: [version: DocumentVersion]
  downloadVersion: [version: DocumentVersion]
}>()
const previewedVersion = defineModel<DocumentVersion | null>('previewedVersion', {
  required: true,
})

const { lists, load, loadMoreVersions, addComment, reply, resolve, removeComment, saveVersion } =
  useDocumentPanel(props.session, props.refreshThreads)

const commentText = ref('')
const replyingTo = ref<string | null>(null)
const replyText = ref('')
const isSavingVersion = ref(false)
const isNamingVersion = ref(false)
const versionName = ref('')
const versionNameInput = ref<{ focus(): void } | null>(null)

// A closing menu hands focus back to its trigger a moment later
const MENU_FOCUS_RETURN_MS = 250

// Guests may sign their comments. Signed-in users never see the field (spec §10.5)
const {
  shown: showGuestName,
  text: guestName,
  atLimit: guestNameAtLimit,
  maxLength: guestNameMaxLength,
  take: takeGuestName,
} = useDriveGuestName()

const isCommentsPanel = computed(() => panel.value === 'comments')
const title = computed(() => (isCommentsPanel.value ? 'Comments' : 'Versions'))
const isCommentBlank = computed(() => !commentText.value.trim())
const shownDrafts = computed(() => props.drafts?.drafts.value ?? [])
const threadGroups = computed(() => groupThreads(props.threads, props.places))
const hasNoThreads = computed(() => !props.threads.length && !shownDrafts.value.length)
const isReplyBlank = computed(() => !replyText.value.trim())
const hasNoVersions = computed(() => !lists.versions.length)
const showsVersionName = computed(() => isNamingVersion.value && panel.value === 'versions')
const versionNameHint = computed(() =>
  isSavingVersion.value ? 'Saving first…' : 'Enter to save · Esc to cancel',
)
const guestNameHint = computed(() => {
  if (guestNameAtLimit.value) {
    return `Names can have up to ${GUEST_NAME_LIMIT} characters.`
  }

  return 'Optional. Shown with your comments.'
})

watch(
  panel,
  (kind) => {
    if (kind) {
      void load(kind)
    }

    if (kind !== 'versions') {
      stopNamingVersion()
    }
  },
  { immediate: true },
)

function closePanel() {
  const closed = panel.value
  panel.value = null
  if (closed) {
    emit('closed', closed)
  }
}

async function submitComment() {
  const text = commentText.value.trim()
  if (!text || !props.canComment) {
    return
  }

  if (await addComment(text, takeGuestName())) {
    commentText.value = ''
  }
}

function writeDraft(draft: ShownDraft, text: string) {
  props.drafts?.write(draft, text)
}

function postDraft(draft: ShownDraft) {
  void props.drafts?.post(draft, takeGuestName())
}

async function discardDraft(draft: ShownDraft) {
  const isConfirmed =
    !draft.text.trim() ||
    (await confirm({
      title: 'Discard comment?',
      message: "It hasn't been posted, and can't be brought back.",
      confirmLabel: 'Discard',
      destructive: true,
    }))
  if (isConfirmed) {
    props.drafts?.discard(draft)
  }
}

function startReply(thread: DocumentThread) {
  replyingTo.value = thread.name
  replyText.value = ''
}

async function submitReply(thread: DocumentThread) {
  const text = replyText.value.trim()
  if (!text || !props.canComment) {
    return
  }

  if (await reply(thread.name, text, takeGuestName())) {
    replyingTo.value = null
    replyText.value = ''
  }
}

// Untitled when the editor can't group threads, so it isn't a named region then
function groupLabel(group: ThreadGroup) {
  return group.title || undefined
}

function isReplying(thread: DocumentThread) {
  return replyingTo.value === thread.name
}

function toggleResolved(thread: DocumentThread) {
  void resolve(thread.name, !thread.resolved)
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
    await removeComment(comment.name)
  }
}

function threadClass(thread: DocumentThread) {
  return thread.resolved ? 'opacity-60' : ''
}

function authorImage(comment: ThreadComment) {
  return comment.person?.user_image ?? undefined
}

function authorLabel(comment: ThreadComment) {
  return comment.person?.full_name || comment.author || 'Someone'
}

// Opens a name box at the top of the list; Enter saves, Esc or an empty name cancels
async function startNamingVersion() {
  isNamingVersion.value = true
  await nextTick()
  function take() {
    versionNameInput.value?.focus()
  }

  take()
  document.addEventListener('focusin', take, { once: true })
  setTimeout(() => document.removeEventListener('focusin', take), MENU_FOCUS_RETURN_MS)
}

function stopNamingVersion() {
  isNamingVersion.value = false
  versionName.value = ''
}

async function saveNamedVersion() {
  const label = versionName.value.trim()
  if (!label) {
    stopNamingVersion()
    return
  }

  isSavingVersion.value = true
  try {
    if (await saveVersion(label, props.saveFirst)) {
      stopNamingVersion()
    }
  } finally {
    isSavingVersion.value = false
  }
}

defineExpose({ reloadVersions: () => load('versions'), startNamingVersion })
</script>

<template>
  <Transition
    enter-active-class="md:transition-[width] md:duration-300 md:ease-in-out"
    enter-from-class="md:!w-0"
    leave-active-class="md:transition-[width] md:duration-300 md:ease-in-out"
    leave-to-class="md:!w-0"
  >
    <aside
      v-if="panel"
      :aria-label="title"
      class="absolute bottom-0 right-0 top-0 z-20 w-full overflow-hidden border-l border-outline-gray-1 bg-surface-elevation-1 shadow-xl md:static md:w-80 md:shrink-0 md:border-outline-gray-2 md:bg-surface-base md:shadow-none"
    >
      <div class="flex h-full w-full flex-col md:w-80 md:p-2">
        <div
          class="flex min-h-12 items-center justify-between border-b px-4 md:min-h-0 md:border-b-0 md:pb-1 md:pl-2 md:pr-1"
        >
          <h2 class="text-lg-semibold md:text-base-medium md:text-ink-gray-8">
            {{ title }}
          </h2>
          <Button icon="lucide-x" aria-label="Close panel" variant="ghost" @click="closePanel" />
        </div>
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 md:px-2 md:pb-2 md:pt-0.5">
          <div v-if="showsVersionName" class="space-y-1">
            <TextInput
              ref="versionNameInput"
              v-model="versionName"
              placeholder="Version name"
              aria-label="Version name"
              :disabled="isSavingVersion"
              @keydown.enter.prevent="saveNamedVersion"
              @keydown.esc.prevent="stopNamingVersion"
            />
            <p class="text-p-xs text-ink-gray-5">{{ versionNameHint }}</p>
          </div>
          <p v-if="lists.isLoading" class="text-sm text-ink-gray-5">Loading…</p>
          <template v-else-if="isCommentsPanel">
            <form v-if="canComment" class="space-y-2" @submit.prevent="submitComment">
              <TextInput
                v-if="showGuestName"
                v-model="guestName"
                label="Your name"
                placeholder="Guest"
                autocomplete="name"
                :maxlength="guestNameMaxLength"
                :description="guestNameHint"
              />
              <div class="flex gap-2">
                <TextInput
                  v-model="commentText"
                  class="flex-1"
                  placeholder="Add a comment"
                  aria-label="New comment"
                />
                <Button type="submit" label="Add" :disabled="isCommentBlank" />
              </div>
            </form>
            <section v-if="shownDrafts.length" class="space-y-2" aria-label="Not posted yet">
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
            <section
              v-for="group in threadGroups"
              :key="group.title"
              class="space-y-2"
              :aria-label="groupLabel(group)"
            >
              <h3 v-if="group.title" class="text-sm-medium text-ink-gray-5">{{ group.title }}</h3>
              <article
                v-for="{ thread, quote } in group.threads"
                :key="thread.name"
                class="space-y-2 rounded-4 bg-surface-gray-1 p-3"
                :class="threadClass(thread)"
              >
                <p v-if="quote" class="truncate border-l-2 pl-2 text-p-sm text-ink-gray-5">
                  {{ quote }}
                </p>
                <div v-for="comment in thread.comments" :key="comment.name">
                  <div class="flex items-center gap-2">
                    <p class="flex flex-1 items-center gap-2 text-sm-medium text-ink-gray-8">
                      <Avatar
                        v-if="comment.person"
                        :image="authorImage(comment)"
                        :label="comment.person.full_name"
                        size="sm"
                        shape="circle"
                      />
                      <DriveCommentAuthor
                        :author="comment.author"
                        :author-name="comment.author_name"
                        >{{ authorLabel(comment) }}</DriveCommentAuthor
                      >
                    </p>
                    <Button
                      v-if="canComment"
                      size="sm"
                      variant="ghost"
                      icon="lucide-trash-2"
                      aria-label="Delete comment"
                      @click="deleteComment(comment)"
                    />
                  </div>
                  <p class="whitespace-pre-wrap text-p-sm text-ink-gray-7">
                    {{ comment.content }}
                  </p>
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
              </article>
            </section>
            <p v-if="hasNoThreads" class="text-sm text-ink-gray-5">No comments yet.</p>
          </template>
          <template v-else>
            <VersionList
              v-model:previewed="previewedVersion"
              :versions="lists.versions"
              :can-restore="canRestoreVersion"
              :is-restoring="isRestoringVersion"
              @restore="emit('restoreVersion', $event)"
              @download="emit('downloadVersion', $event)"
            />
            <p v-if="hasNoVersions" class="px-3 text-sm text-ink-gray-5">No versions yet.</p>
            <Button
              v-if="lists.versionsCursor"
              class="w-full"
              variant="ghost"
              label="Load more"
              :loading="lists.isLoadingMore"
              @click="loadMoreVersions"
            />
          </template>
        </div>
      </div>
    </aside>
  </Transition>
</template>
