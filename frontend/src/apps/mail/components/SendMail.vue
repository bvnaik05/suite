<template>
  <!-- Desktop's composer window. Mobile composes on a page of its own — see ComposeView — so
	     nothing here has a mobile form; the openers navigate there instead of mounting this.

	     It opens docked in the bottom-right corner, so the mail being written about stays on screen
	     beside it (#407), and expands to a larger window centred over the page. One window either
	     way, sized by its classes rather than swapped for a Dialog: swapping containers would remount
	     TipTap and take the draft with it.

	     Teleported to Mail's overlay layer: the layout's `isolate` paints its subtree as one unit, so
	     a composer opened from inside a thread would otherwise lose to the thread pane, which
	     teleports out itself. Nothing traps focus or locks scrolling — docked, the page behind is
	     simply live; expanded, a click on the dimmed page minimises the window: clicking away from a
	     draft means "let me look at that", not "throw this out". Restoring brings it back expanded. -->
  <Teleport :to="overlayLayer ?? 'body'">
    <Transition
      enter-from-class="opacity-0"
      enter-active-class="transition-opacity duration-150 ease-out"
      leave-active-class="transition-opacity duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="show && expanded && !minimised"
        class="bg-black-overlay-200 dark:bg-black-overlay-700 fixed inset-0 z-40"
        @click="minimised = true"
      />
    </Transition>
    <!-- Rises and fades in from the corner, and sinks back out a little faster than it came. -->
    <!-- `appear`: the window is mounted already open, the first time and whenever its opener
         mounts it afresh. -->
    <Transition
      appear
      enter-from-class="translate-y-2 opacity-0"
      enter-active-class="transition duration-150 ease-out"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="translate-y-2 opacity-0"
    >
      <section
        v-if="show"
        role="dialog"
        :aria-label="windowName"
        class="border-outline-gray-2 bg-surface-base fixed z-40 flex flex-col rounded-6 border shadow-xl"
        :class="
          minimised
            ? 'bottom-4 right-4 w-[28rem] max-w-[calc(100vw-2rem)]'
            : expanded
              ? 'inset-0 m-auto h-[min(85vh,760px)] w-[min(960px,calc(100vw-4rem))]'
              : 'bottom-4 right-4 max-h-[calc(100vh-2rem)] w-[600px] max-w-[calc(100vw-2rem)]'
        "
      >
        <!-- Folded away, the bar is the whole window and one wide target that restores it, carrying
             the button role so it is reachable without a pointer; Close stays on it, but nothing
             else that could be mistaken for restore. Its buttons stop the click so they keep their
             own jobs. -->
        <header
          class="border-outline-gray-1 bg-surface-gray-2 flex h-10 shrink-0 items-center gap-1 pl-4 pr-1.5"
          :class="
            minimised ? 'cursor-pointer select-none rounded-[11px]' : 'rounded-t-[11px] border-b'
          "
          :role="minimised ? 'button' : undefined"
          :tabindex="minimised ? 0 : undefined"
          :aria-label="minimised ? __('Restore') : undefined"
          @click="minimised && (minimised = false)"
          @keydown.enter="restore"
          @keydown.space="restore"
        >
          <!-- !text-base: MailLayout's `.mail-app h2` sets every h2 in Mail a size up, and outranks a
             plain utility. -->
          <h2 class="text-ink-gray-9 mr-auto truncate !text-base font-medium">
            {{ title }}
          </h2>
          <Button
            v-if="!minimised"
            variant="ghost"
            :aria-label="__('Minimise')"
            :tooltip="__('Minimise')"
            @click.stop="minimised = true"
          >
            <template #icon><span class="lucide-minus size-4" aria-hidden="true" /></template>
          </Button>
          <Button
            v-if="!minimised"
            variant="ghost"
            :aria-label="expanded ? __('Shrink') : __('Expand')"
            :tooltip="expanded ? __('Shrink') : __('Expand')"
            @click="expanded = !expanded"
          >
            <template #icon>
              <span
                :class="expanded ? 'lucide-arrow-down-right' : 'lucide-arrow-up-left'"
                class="size-4"
                aria-hidden="true"
              />
            </template>
          </Button>
          <Button
            variant="ghost"
            :aria-label="__('Close')"
            :tooltip="__('Close')"
            @click.stop="show = false"
          >
            <template #icon><span class="lucide-x size-4" aria-hidden="true" /></template>
          </Button>
        </header>
        <!-- v-show, never v-if: minimising must not take the draft's editor with it. A wrapper of
             its own, since the editor has more than one root and v-show cannot hide that. -->
        <div v-show="!minimised" class="flex min-h-0 flex-1 flex-col">
          <ComposeMailEditor
            ref="composeMailEditor"
            v-model="show"
            :mail-details
            :expanded
            :reload-mails="() => emit('reloadMails')"
            @discard-mail="emit('discardMail')"
            @discard-started="emit('discardStarted')"
          />
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { Button, usePortalTarget } from 'frappe-ui'
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'

import ComposeMailEditor from '@/apps/mail/components/ComposeMailEditor.vue'
import { claimComposeWindow } from '@/apps/mail/composables/useComposeWindow'
import type { ComposeMailData } from '@/apps/mail/types'

const show = defineModel<boolean>()

const { mailDetails } = defineProps<{ mailDetails?: ComposeMailData }>()

const emit = defineEmits(['reloadMails', 'discardMail', 'discardStarted'])

const editor = useTemplateRef<InstanceType<typeof ComposeMailEditor>>('composeMailEditor')
// MailLayout's overlay layer; see the Teleport above.
const overlayLayer = usePortalTarget()

claimComposeWindow(show, () => editor.value?.mail?.id)

// The draft as it stands in here, for a host that has to take it back. A thread that popped a reply
// out handed over a set of details and got a composer with a draft of its own built from them —
// nothing typed since has reached the thread, so when the reader asks for the draft back it has to
// come from the composer rather than from the copy the thread still remembers.
defineExpose({ mail: computed(() => editor.value?.mail) })

// Each compose starts docked: a request to write is not a request to resume whatever the last
// draft's window happened to be doing.
const expanded = ref(false)
const minimised = ref(false)
watch(show, (open) => {
  if (open) expanded.value = minimised.value = false
})

// What the window is for: a reply or a forward popped out of a thread (or reopened from Drafts)
// says so, rather than calling itself a new message. A popped-out draft arrives without its reply
// type, so the mail it answers or forwards is what tells.
const windowName = computed(() => {
  const kind =
    mailDetails?.type ??
    (mailDetails?.forwarded_from_id ? 'forward' : mailDetails?.in_reply_to ? 'reply' : undefined)
  if (kind === 'forward') return __('Forward')
  if (kind === 'replyAll') return __('Reply all')
  if (kind === 'reply') return __('Reply')
  return __('New message')
})

// Folded, the bar names the draft by its subject once it has one: it is all there is to tell one
// draft from another. Open, the Subject field says that, and the window keeps its own name.
const title = computed<string>(() =>
  minimised.value ? editor.value?.mail?.subject?.trim() || windowName.value : windowName.value,
)

// Enter and Space restore only when the bar itself has focus: it is the ancestor of Close, and
// preventing the key on the way past would cancel the click the browser makes of it on that button.
const restore = (e: KeyboardEvent) => {
  if (!minimised.value || e.target !== e.currentTarget) return
  e.preventDefault()
  minimised.value = false
}

// Esc docks an expanded window. Ignored while a popover is open,
// or a dialog above this window — the contacts picker, Send later — which reka closes on the same
// key without marking it handled.
const onEscape = (e: KeyboardEvent) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !show.value) return
  if (!expanded.value || minimised.value) return
  if (document.querySelector('[data-reka-popper-content-wrapper]')) return
  if (document.querySelector('.dialog-content[data-state="open"]')) return
  expanded.value = false
}

onMounted(() => window.addEventListener('keydown', onEscape))
onUnmounted(() => window.removeEventListener('keydown', onEscape))
</script>
