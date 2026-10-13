import dayjs from '@/apps/mail/utils/dayjs'

/**
 * Grouping a list by date, finer for recent mail and coarser the further back it goes: a group per
 * day this week, a group per week for the three weeks before it, then a group per month. The day and
 * week groups run back regardless of months, so they can take a month's last days; that month's
 * group, holding only what is left of it, says so ("Earlier in September", "Earlier this month")
 * rather than reading as the whole month. The groups follow one another in time, so a list sorted
 * newest first meets each once, in order.
 *
 * A group's key is 'today', 'yesterday', 'day:YYYY-MM-DD' for an earlier day this week, 'week:N' for
 * the week N weeks before this one, or 'YYYY-MM' for a month (or what is left of one).
 */
const WEEKS = 3

/** Where the week groups end: everything before it is grouped by month. */
const weeksEnd = (now: Date | string) =>
  dayjs(now).startOf('day').startOf('week').subtract(WEEKS, 'week')

export const dateGroup = (date: Date | string, now: Date | string = new Date()): string => {
  const day = dayjs(date)
  const today = dayjs(now).startOf('day')
  const thisWeek = today.startOf('week')
  // Each check takes what the ones before it left, so a range that an earlier one already covers
  // (this week starting yesterday, say) simply holds nothing.
  if (!day.isBefore(today)) return 'today'
  if (!day.isBefore(today.subtract(1, 'day'))) return 'yesterday'
  if (!day.isBefore(thisWeek)) return `day:${day.format('YYYY-MM-DD')}`
  for (let weeks = 1; weeks <= WEEKS; weeks++)
    if (!day.isBefore(thisWeek.subtract(weeks, 'week'))) return `week:${weeks}`
  return day.format('YYYY-MM')
}

/** What a group's header reads. */
export const dateGroupLabel = (key: string, now: Date | string = new Date()): string => {
  if (key === 'today') return __('Today')
  if (key === 'yesterday') return __('Yesterday')
  if (key.startsWith('day:')) return dayjs(key.slice(4)).format('dddd')
  if (key.startsWith('week:')) {
    const weeks = key.slice(5)
    return weeks === '1' ? __('Last week') : __('{0} weeks ago', [weeks])
  }
  const month = dayjs(`${key}-01`)
  // Only the month the week groups end in can have lost days to them, and only if they end after
  // its first day.
  const end = weeksEnd(now)
  const partial = end.isSame(month, 'month') && end.isAfter(month)
  if (partial && month.isSame(now, 'month')) return __('Earlier this month')
  const name = month.format(month.year() === dayjs(now).year() ? 'MMMM' : 'MMMM YYYY')
  return partial ? __('Earlier in {0}', [name]) : name
}
