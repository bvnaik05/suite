<script setup lang="ts">
import type { CollabRoom } from '@suite/collab-client'
import type { Editor } from '@tiptap/core'
import { Badge, Button, Skeleton, toast } from 'frappe-ui'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
} from 'vue'

import { api, useMutation } from '@/api'
import {
  DriveDocumentHeader,
  type DocumentPanel,
  type DocumentSession,
  type DocumentVersion,
} from '@/apps/drive'
import { withinTenSeconds } from '@/apps/writer/collab/timeout'
import CollabTextEditor from '@/apps/writer/components/CollabTextEditor.vue'
import NonCollabEditor from '@/apps/writer/components/NonCollabEditor.vue'
import TextEditor from '@/apps/writer/components/TextEditor.vue'
import UsersBar from '@/apps/writer/components/UsersBar.vue'
import type { CollaborationUser } from '@/apps/writer/composables/useCollaborationUsers'
import emitter from '@/apps/writer/emitter'
import { DOCUMENT_MEDIA } from '@/apps/writer/extensions/drive-media'
import { RENAME_DOCUMENT } from '@/apps/writer/renameDocument'
import { belowMinBuild } from '@/platform/build'

import DocumentSidePanel from './DocumentSidePanel.vue'
import {
  resolveDocumentUnload,
  useDocumentLeaveGuard,
  type DocumentSaveState,
  type LeaveGuardOptions,
} from './navigation'
import { clearRecovery, downloadRecovery, keepRecovery, readRecovery } from './recovery'
import { versionLabel } from './useDocumentPanel'
import { useWriterCollab } from './useWriterCollab'
import VersionPreview from './VersionPreview.vue'
import { createWriterDocument, isLocked } from './writerDocument'
import WriterDocumentMenu from './WriterDocumentMenu.vue'
import { createWriteGate, type DocumentWrite } from './writes'

const COMMENT = 20

/** What `TextEditor` and `NonCollabEditor` expose. */
interface EditorSurface {
  editor?: Editor | null
  /** Other people in the document; only the collaborative editor has them. */
  peers?: CollaborationUser[]
}

const props = defineProps<{ session: DocumentSession }>()

/** The file as every editor reads it. */
type EditorFile = (typeof editorFile)['value']

/** The editor that shows this document, with the props only it takes. */
type EditorView =
  | { is: typeof CollabTextEditor; props: { room: CollabRoom; file: EditorFile } }
  | {
      is: typeof NonCollabEditor | typeof TextEditor
      props: ReturnType<typeof dirtyModel> & { file: EditorFile }
    }

const editorSurface = shallowRef<EditorSurface | null>(null)
/** The editor's own unsaved flag, bound to its `dirty` model. */
const dirty = ref(false)
const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)
const panel = ref<DocumentPanel | null>(null)
const previewedVersion = ref<DocumentVersion | null>(null)

const hasRecovery = ref(readRecovery(props.session.nodeId) !== null)

const {
  mode: collabMode,
  room,
  isLive: collabLive,
  allowsEditing,
  editingPaused,
  saveState: roomSaveState,
  unsent: roomUnsent,
  paused: roomPaused,
  banner,
  openFailure,
  open: openCollab,
  close: closeCollab,
} = useWriterCollab(props.session, retainRecovery, () => writes.writable.value)

const writes = createWriteGate(props.session, () => {
  const roomUnsaved = collabLive.value && saveState.value !== 'clean'
  const unsaved = dirty.value || roomUnsaved
  if (unsaved) {
    retainRecovery()
  }
  editorSurface.value?.editor?.setEditable(false)
  if (!unsaved) {
    toast.warning('Editing access changed. This document is now read-only.')
    return
  }
  toast.warning('Editing access changed. Your unsaved changes are kept on this device.', {
    duration: Number.POSITIVE_INFINITY,
    action: { label: 'Download my changes', onClick: downloadChanges },
  })
})

const writerDocument = createWriterDocument(props.session)

const version = useMutation(api.drive.versions.create, {
  context: props.session.credentials.context,
  silent: true,
})

const automaticVersion: DocumentWrite = {
  get isPending() {
    return version.isPending
  },
  get error() {
    return version.error
  },
  run: () => version.run({ node: props.session.nodeId, kind: 'auto' }),
}

const documentResource = writes.guard(
  Object.assign(writerDocument, { newVersion: automaticVersion }),
  ['saveDoc', 'saveHtml', 'newVersion'],
)

const readable = computed(() => props.session.state.value !== 'Refused' && writes.role.value >= 10)

const canComment = computed(
  () => props.session.state.value === 'Active' && writes.role.value >= COMMENT,
)

const saving = computed(
  () => !!documentResource.saveDoc?.isPending || !!documentResource.saveHtml?.isPending,
)

const saveFailed = computed(
  () => !!documentResource.saveDoc?.error || !!documentResource.saveHtml?.error,
)

const resourceSaveState = computed<DocumentSaveState>(() =>
  saving.value ? 'saving' : saveFailed.value ? 'failed' : dirty.value ? 'unsaved' : 'clean',
)

const saveState = computed<DocumentSaveState>(() => roomSaveState.value ?? resourceSaveState.value)
const savingPaused = computed(() => !!roomPaused.value && saveState.value !== 'failed')

const saveNote = computed(() =>
  [savingPaused.value && 'Saving paused', roomUnsent.value && `${roomUnsent.value} unsent`]
    .filter(Boolean)
    .join(' · '),
)

const settings = computed(() => documentResource.doc?.settings ?? {})

const editable = computed(
  () =>
    readable.value &&
    writes.writable.value &&
    !isLocked(settings.value) &&
    allowsEditing.value &&
    !belowMinBuild('writer'),
)

const showEditingPaused = computed(
  () => !editable.value && editingPaused.value && writes.writable.value,
)

const editorFile = computed(() => ({
  doc: {
    name: props.session.nodeId,
    file_name: props.session.title.value,
    write: editable.value,
    modified: new Date().toISOString(),
  },
}))

const peers = computed(() => editorSurface.value?.peers ?? [])

// The non-collaborative editors bind `dirty` as a model
function dirtyModel() {
  return {
    dirty: dirty.value,
    'onUpdate:dirty': (value: boolean) => (dirty.value = value),
  }
}

const editorView = computed<EditorView>(() => {
  const file = editorFile.value
  if (collabLive.value && room.value) {
    return { is: CollabTextEditor, props: { room: room.value, file } }
  }

  const editorProps = { file, ...dirtyModel() }
  const isCollabOff = documentResource.doc?.collab === 0
  return { is: isCollabOff ? NonCollabEditor : TextEditor, props: editorProps }
})

provide('file', editorFile)

provide(
  'isOffline',
  computed(() => !online.value),
)

provide(RENAME_DOCUMENT, async (title) => {
  await props.session.rename(title)
})

provide(DOCUMENT_MEDIA, (id) => props.session.media(id))

// A save that lands with edit access makes the recovery copy stale.
watch(saving, (now, before) => {
  if (!before || now || saveFailed.value || !writes.writable.value || !hasRecovery.value) {
    return
  }

  clearRecovery(props.session.nodeId)
  hasRecovery.value = false
})

async function closePreview() {
  const pressedVersionButton = document.querySelector<HTMLElement>(
    'aside button[aria-pressed="true"]',
  )
  previewedVersion.value = null
  await nextTick()
  if (pressedVersionButton) {
    pressedVersionButton.focus()
  } else {
    editorSurface.value?.editor?.commands.focus()
  }
}

function retainRecovery(): boolean {
  const html = editorSurface.value?.editor?.getHTML()
  if (!html) {
    return false
  }

  try {
    keepRecovery(props.session.nodeId, html)
  } catch {
    return false
  }

  hasRecovery.value = true
  return true
}

function downloadChanges() {
  const downloaded = downloadRecovery(props.session.nodeId, props.session.title.value)
  hasRecovery.value = false
  if (!downloaded) {
    toast.error('No recovery copy is kept for this document.')
  }
}

function flush(): Promise<void> {
  if (room.value) {
    return withinTenSeconds(room.value.flush())
  }

  if (!dirty.value && !saving.value) {
    return Promise.resolve()
  }

  const saved = new Promise<void>((resolve) => {
    emitter.emit('manual-save', () => resolve())
  })
  return withinTenSeconds(saved)
}

useDocumentLeaveGuard({ state: () => saveState.value, flush, retainRecovery })

function warnBeforeUnload(event: Event) {
  const unloadGuard: Pick<LeaveGuardOptions, 'state' | 'retainRecovery'> = {
    state: () => (collabLive.value ? saveState.value : 'clean'),
    retainRecovery,
  }
  resolveDocumentUnload(unloadGuard, event)
}

function setOnline() {
  online.value = true
  void room.value?.pull()
}

function setOffline() {
  online.value = false
  void room.value?.pull()
}

onMounted(() => {
  window.addEventListener('online', setOnline)
  window.addEventListener('offline', setOffline)
  window.addEventListener('beforeunload', warnBeforeUnload)
  void openCollab()
})

onBeforeUnmount(() => {
  window.removeEventListener('online', setOnline)
  window.removeEventListener('offline', setOffline)
  window.removeEventListener('beforeunload', warnBeforeUnload)
  closeCollab()
})
</script>

<template>
  <div class="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-surface-base">
    <DriveDocumentHeader
      v-model:panel="panel"
      :session="session"
      title-label="Document title"
      :save-state="savingPaused ? null : saveState"
      :view-only="!editable && !showEditingPaused"
      :recoverable="hasRecovery"
      :panels="['comments', 'versions']"
      @download-changes="downloadChanges"
    >
      <template #status>
        <Badge
          v-if="showEditingPaused"
          label="Editing paused"
          theme="gray"
          variant="subtle"
          class="shrink-0"
        />
      </template>
      <template #actions>
        <span
          v-if="savingPaused || roomUnsent"
          class="mr-1 whitespace-nowrap text-sm text-ink-gray-5"
          aria-live="polite"
        >
          {{ saveNote }}
        </span>
        <UsersBar v-if="peers.length" :users="peers" />
        <WriterDocumentMenu
          v-if="readable"
          :session="session"
          :editor="editorSurface?.editor ?? null"
          :settings="settings"
          :editable="editable"
        />
      </template>
    </DriveDocumentHeader>

    <div
      v-if="banner"
      class="shrink-0 border-b border-outline-gray-1 bg-surface-amber-2 px-5 py-2 text-sm text-ink-amber-7"
      role="status"
    >
      {{ banner.text
      }}<a v-if="banner.link" :href="banner.link.href" target="_blank" class="underline">{{
        banner.link.label
      }}</a
      >{{ banner.after }}
    </div>

    <div class="relative flex min-h-0 flex-1 flex-col">
      <div v-if="!readable" class="m-auto text-center">
        <span class="lucide-lock-keyhole mx-auto block size-6 text-ink-gray-5" aria-hidden="true" />
        <p class="mt-2 text-p-sm text-ink-gray-6">
          You no longer have permission to read this document.
        </p>
      </div>
      <div v-else-if="collabMode === 'failed'" class="m-auto text-center">
        <p class="text-p-sm text-ink-gray-6">{{ openFailure }}</p>
        <Button class="mt-3" label="Try again" @click="openCollab" />
      </div>
      <div
        v-else-if="!documentResource.doc || collabMode === 'opening'"
        class="mx-auto w-full max-w-[770px] space-y-3 px-5 pt-10"
      >
        <Skeleton
          v-for="width in ['70%', '92%', '84%', '60%', '88%']"
          :key="width"
          class="h-3.5 rounded-4"
          :style="{ width }"
        />
      </div>
      <template v-else>
        <div class="flex min-h-0 flex-1 overflow-hidden">
          <component
            :is="editorView.is"
            ref="editorSurface"
            v-bind="editorView.props"
            :document="documentResource"
            :settings="settings"
            :editable="editable"
          >
            <template v-if="previewedVersion" #toolbar>
              <div
                class="flex shrink-0 items-center justify-between gap-3 border-b border-outline-elevation-2 px-5 py-1.5"
                role="status"
              >
                <p class="truncate text-sm text-ink-gray-7">
                  Viewing {{ versionLabel(previewedVersion) }}
                </p>
                <Button size="sm" variant="ghost" label="Back to current" @click="closePreview" />
              </div>
            </template>
            <template v-if="previewedVersion" #cover>
              <VersionPreview :session="session" :seq="previewedVersion.seq" :settings="settings" />
            </template>
            <template #aside>
              <DocumentSidePanel
                v-model:panel="panel"
                v-model:previewed-version="previewedVersion"
                :session="session"
                :can-comment="canComment"
              />
            </template>
          </component>
        </div>
      </template>
    </div>
  </div>
</template>
