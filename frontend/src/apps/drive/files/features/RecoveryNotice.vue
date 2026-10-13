<script setup lang="ts">
import { Alert } from 'frappe-ui'
import { computed, inject, onMounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'

import { DOCUMENT_TYPES_KEY } from '@/platform/contracts'

// The copies this device kept when the person last dismissed the notice
const DISMISSED_KEY = 'suite:drive-recovery-notice-dismissed'

const documentTypes = inject(DOCUMENT_TYPES_KEY, [])
const router = useRouter()
const copies = shallowRef<{ key: string; document: string }[]>([])
const dismissed = shallowRef(readDismissed())

// A copy that appears after a dismissal shows the notice again
const shown = computed(() => copies.value.some((copy) => !dismissed.value.includes(copy.key)))
const title = computed(() => {
  const count = new Set(copies.value.map((copy) => copy.document)).size
  if (count === 1) {
    return "1 document has changes that couldn't be saved."
  }

  return `${count} documents have changes that couldn't be saved.`
})
const review = {
  label: 'Review',
  onClick: () => {
    void router.push('/drive/recovery')
  },
}

onMounted(async () => {
  const lists = await Promise.all(documentTypes.map(typeCopies))
  copies.value = lists.flat()
})

async function typeCopies(type: (typeof documentTypes)[number]) {
  const entries = (await type.listUnsavedCopies?.().catch(() => [])) ?? []
  return entries.map((entry) => ({
    key: `${type.key}:${entry.key}`,
    document: `${type.key}:${entry.document}`,
  }))
}

function dismiss() {
  dismissed.value = copies.value.map((copy) => copy.key)
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed.value))
  } catch {
    // Blocked storage keeps the dismissal for this page only
  }
}

function readDismissed(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')
    if (Array.isArray(stored)) {
      return stored
    }
  } catch {
    return []
  }

  return []
}
</script>

<template>
  <Alert
    v-if="shown"
    theme="blue"
    :title="title"
    :primary-action="review"
    dismissible
    @dismiss="dismiss"
  />
</template>
