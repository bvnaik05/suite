<template>
  <Dropdown align="end" :options="users">
    <template #default>
      <button
        type="button"
        class="flex items-center rounded-4 cursor-pointer"
        :aria-label="
          users.length === 1 ? `${users[0].name} is here` : `${users.length} other people here`
        "
      >
        <div
          v-for="(user, index) in users.slice(0, 3)"
          :key="user.name"
          class="flex items-center rounded-full"
          :class="{ 'ml-0.5': index }"
        >
          <Tooltip :text="user.name">
            <Avatar
              v-if="user.avatar"
              class="peer-colour peer-avatar"
              :size="'md'"
              :style="ringStyle(user)"
              :image="user.avatar"
              :label="user.name"
            />
            <span v-else class="peer-colour peer-avatar peer-initials" :style="ringStyle(user)">
              {{ initialsOf(user.name) }}
            </span>
          </Tooltip>
        </div>
        <Tooltip v-if="users.length > 3" :text="`${users.length - 3} more users`">
          <div
            :style="{ marginLeft: '2px', fontSize: '10px' }"
            class="relative inline-block shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-surface-gray-2 text-ink-gray-5 text-xs cursor-pointer border-[1.5px] border-gray-300"
          >
            +{{ users.length - 3 }}
          </div>
        </Tooltip>
      </button>
    </template>
    <template #item="{ item }">
      <div
        class="flex items-center justify-between py-1.5 px-2 rounded-4 cursor-pointer hover:bg-surface-gray-1 focus:outline-none"
      >
        <div class="flex gap-2 items-center">
          <Tooltip :text="item.name">
            <Avatar :size="'md'" :image="item.avatar" :label="item.name" />
          </Tooltip>
          <div class="text-sm text-ink-gray-8 mr-4 flex flex-col gap-0.5">
            <span>{{ item.name }}</span>
            <span class="text-xs text-ink-gray-5">{{ item.id }}</span>
          </div>
        </div>
        <svg
          class="ml-auto"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle
            class="peer-colour"
            :style="ringStyle(item)"
            cx="8"
            cy="8"
            r="4.5"
            fill="transparent"
            stroke="var(--peer-solid)"
            stroke-width="3"
          />
        </svg>
      </div>
    </template>
  </Dropdown>
</template>
<script setup>
import { Avatar, Dropdown, Tooltip } from 'frappe-ui'

import { colourStyle } from '@/apps/writer/collab/colours'

defineProps({
  users: Array,
})

// A collaborative document's person has a colour with a dark-mode variant; the older editor's has one colour
function ringStyle(user) {
  if (user.colour) {
    return colourStyle(user.colour)
  }

  return { '--peer-light': user.color, '--peer-dark': user.color, '--peer-light-ink': user.color }
}

// The first letters of a person's first two names
function initialsOf(name) {
  const words = name.split(' ').filter(Boolean)
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
}
</script>

<style scoped>
/* The page's colour between the avatar and its ring */
.peer-avatar {
  border-radius: 50%;
  box-shadow:
    0 0 0 2px var(--surface-base),
    0 0 0 3.5px var(--peer-solid);
}

/* Filled with the person's ink in both themes, so the white initials read */
.peer-initials {
  align-items: center;
  background-color: var(--peer-light-ink);
  color: #ffffff;
  display: inline-flex;
  font-size: 11px;
  font-weight: 600;
  height: 24px;
  justify-content: center;
  width: 24px;
}
</style>
