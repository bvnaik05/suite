<template>
  <Tooltip :text="tooltipText" :disabled="inList">
    <div class="text-ink-gray-5 text-nowrap text-xs" :class="{ 'mr-1': !inList }">
      {{ formattedDate }}
    </div>
  </Tooltip>
</template>
<script setup lang="ts">
import { useTimeAgo } from '@vueuse/core'
import { Tooltip } from 'frappe-ui'
import { computed, inject } from 'vue'

import { formatMessageTime, useMinuteClock } from '@/apps/mail/utils/datetime'

const {
  datetime,
  inList = false,
  inThread = false,
  clock = false,
} = defineProps<{ datetime: string; inList?: boolean; inThread?: boolean; clock?: boolean }>()

const dayjs = inject('$dayjs')
const now = useMinuteClock()

const formattedDate = computed(() => {
  // Under a header that already names the day, the clock is all a row needs to add.
  if (clock) return dayjs(datetime).format('h:mm A')
  // A thread's rows carry the clock as well as the day: the sequence and the gaps between
  // replies, which a relative stamp hides.
  if (inThread) return formatMessageTime(datetime, now.value)
  if (!inList) {
    const timeAgo = useTimeAgo(datetime).value
    return __(timeAgo.charAt(0).toUpperCase() + timeAgo.slice(1))
  }
  if (dayjs(datetime).isToday()) return dayjs(datetime).format('h:mm A')
  if (dayjs(datetime).isYesterday()) return __('Yesterday')
  if (dayjs(datetime).year() === dayjs().year()) return dayjs(datetime).format('D MMM')
  return dayjs(datetime).format('D MMM YYYY')
})

const tooltipText = computed(() =>
  __(`${dayjs(datetime).format('D MMM YYYY')} at ${dayjs(datetime).format('h:mm A')}`),
)
</script>
