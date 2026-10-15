import { useEventListener } from '@vueuse/core'
import { ref, watch } from 'vue'

import type { DocumentThread } from '@/apps/drive'

/**
 * Which comment threads changed since this person last opened them, kept on
 * this device per person and document. Blocked storage keeps nothing and never
 * throws, so what was opened lasts only as long as the tab.
 */
interface SeenMarks {
  [thread: string]: string
}

interface SeenOptions {
  user: string
  node: string
  threads: () => DocumentThread[]
  /** Whether Drive's threads have been read; until then nothing shows as changed. */
  hasLoaded: () => boolean
  openThread: () => string | null
}

const PREFIX = 'suite:writer-seen-threads:'

/** What a thread held when last opened, by thread; null when this document was never opened here. */
export function readSeen(user: string, node: string): SeenMarks | null {
  try {
    return parseSeen(localStorage.getItem(keyOf(user, node)))
  } catch {
    return null
  }
}

function parseSeen(value: string | null): SeenMarks | null {
  let stored: unknown
  try {
    stored = JSON.parse(value ?? 'null')
  } catch {
    return null
  }

  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return null
  }

  const marks = Object.entries(stored).filter(([, mark]) => typeof mark === 'string')
  return Object.fromEntries(marks)
}

export function keepSeen(user: string, node: string, marks: SeenMarks) {
  try {
    localStorage.setItem(keyOf(user, node), JSON.stringify(marks))
  } catch {
    // Blocked or full storage: what was opened lives only in this tab
  }
}

function keyOf(user: string, node: string) {
  return `${PREFIX}${user}:${node}`
}

/** Changes with a new or deleted comment, an edit, and a resolve or reopen. */
export function threadMark(thread: DocumentThread) {
  const [latest = ''] = thread.comments
    .map((comment) => comment.modified ?? '')
    .sort()
    .reverse()
  return `${thread.comments.length}:${latest}:${thread.resolved}`
}

function marksOf(threads: DocumentThread[]) {
  return Object.fromEntries(threads.map((thread) => [thread.name, threadMark(thread)]))
}

// A document first opened on this device starts with every thread seen, once they load
function startingMarks(user: string, node: string, threads: DocumentThread[], isLoaded: boolean) {
  const kept = readSeen(user, node)
  if (kept || !isLoaded) {
    return kept
  }

  const marks = marksOf(threads)
  keepSeen(user, node, marks)
  return marks
}

// The marks with the named thread seen as it is now, when it is listed
function withSeen(marks: SeenMarks, threads: DocumentThread[], name: string | null) {
  const thread = threads.find((listed) => listed.name === name)
  if (!thread) {
    return marks
  }

  return { ...marks, [thread.name]: threadMark(thread) }
}

// Another tab on this device opening a thread clears it here too
function followOtherTabs(key: string, follow: (marks: SeenMarks) => void) {
  useEventListener(window, 'storage', (event) => {
    if (event.key !== key) {
      return
    }

    const incoming = parseSeen(event.newValue)
    if (incoming) {
      follow(incoming)
    }
  })
}

/** The threads changed since last opened here; the open thread stays seen as it changes. */
export function useSeenThreads({ user, node, threads, hasLoaded, openThread }: SeenOptions) {
  const marks = ref<SeenMarks | null>(null)

  function markSeen(name: string | null) {
    marks.value ??= startingMarks(user, node, threads(), hasLoaded())
    if (!marks.value) {
      return
    }

    // Read again, since another tab may have marked threads since
    marks.value = withSeen(readSeen(user, node) ?? marks.value, threads(), name)
    keepSeen(user, node, marks.value)
  }

  watch([threads, hasLoaded, openThread], ([, , open]) => markSeen(open), { immediate: true })
  // The thread open here stays seen here alone; writing it back would fight a tab with older threads
  followOtherTabs(keyOf(user, node), (incoming) => {
    marks.value = withSeen(incoming, threads(), openThread())
  })

  return {
    isUnread: (thread: DocumentThread) =>
      marks.value !== null && marks.value[thread.name] !== threadMark(thread),
    markSeen,
  }
}
