<template>
  <!-- Who sent a message, and what the reader can do about them: write to them, keep their
	     address, or find the rest of their mail. Opened from the sender in an open message. -->
  <div class="w-72" @click.stop>
    <div class="flex items-center gap-2.5 p-3 pb-2.5">
      <Avatar :label="initial" :image="image" size="xl" />
      <div class="min-w-0">
        <p class="text-ink-gray-8 truncate text-base font-semibold">{{ name }}</p>
        <p class="text-ink-gray-5 truncate text-sm">{{ email }}</p>
      </div>
    </div>
    <!-- Everything here acts on the address, so the three sit together as equals. -->
    <div class="px-3 pb-3">
      <!-- A soft fill rather than a border, and faint rules between the three: the card is the
		       thing to read, the bar only what to do with it. -->
      <div class="bg-surface-gray-1 divide-outline-gray-1 grid grid-cols-3 divide-x rounded-6">
        <button
          v-for="action in actions"
          :key="action.label"
          type="button"
          class="text-ink-gray-7 hover:bg-surface-gray-2 hover:text-ink-gray-8 py-1 text-sm first:rounded-l-6 last:rounded-r-6"
          :title="action.title"
          @click="action.onClick"
        >
          {{ action.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Avatar } from 'frappe-ui'

defineProps<{ name: string; email: string; image?: string; initial?: string }>()
const emit = defineEmits<{ email: []; copy: []; filter: [] }>()

const actions = [
  {
    label: __('Email'),
    title: __('Email this sender'),
    onClick: () => emit('email'),
  },
  {
    label: __('Copy'),
    title: __('Copy address'),
    onClick: () => emit('copy'),
  },
  {
    label: __('Filter'),
    title: __('Filter messages from this sender'),
    onClick: () => emit('filter'),
  },
]
</script>
