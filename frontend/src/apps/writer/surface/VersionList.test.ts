import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'

import type { DocumentVersion } from '@/apps/drive'

import VersionList from './VersionList.vue'

vi.mock('frappe-ui', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    // Shows the menu's items beside its button, as if it were open
    Dropdown: define({
      props: { options: Array as () => { label: string; onClick: () => void }[] },
      setup:
        (props, { slots }) =>
        () =>
          render('div', [
            slots.default?.(),
            props.options?.map((option) =>
              render('button', { role: 'menuitem', onClick: option.onClick }, option.label),
            ),
          ]),
    }),
    Tooltip: define({
      setup:
        (_, { slots }) =>
        () =>
          slots.default?.(),
    }),
  }
})

vi.mock('@/apps/writer/composables/useUsers', () => ({
  fullName: (user: string) => ({ 'ana@example.com': 'Ana Silva' })[user] ?? user,
}))

const NOW = new Date(2026, 9, 15, 18, 0)

const named = version(3, 'Before review', new Date(2026, 9, 15, 14, 14))
const automatic = version(2, null, new Date(2026, 9, 15, 9, 5))
const lastWeek = version(1, null, new Date(2026, 9, 8, 11, 0))

let mounted: App | null = null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  mounted?.unmount()
  document.body.replaceChildren()
  vi.useRealTimers()
})

function version(seq: number, label: string | null, takenAt: Date) {
  const shape = { seq, label, actor: 'ana@example.com', creation: takenAt.toISOString() }
  return shape as unknown as DocumentVersion
}

interface ListOptions {
  canRestore?: boolean
  isRestoring?: boolean
  previewed?: DocumentVersion | null
}

function mountList({ canRestore = true, isRestoring = false, previewed = null }: ListOptions = {}) {
  const shown = ref(previewed)
  const restored: number[] = []
  const downloaded: number[] = []
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(() =>
    h(VersionList, {
      versions: [named, automatic, lastWeek],
      canRestore,
      isRestoring,
      previewed: shown.value,
      'onUpdate:previewed': (next: DocumentVersion | null) => {
        shown.value = next
      },
      onRestore: ({ seq }: DocumentVersion) => restored.push(seq),
      onDownload: ({ seq }: DocumentVersion) => downloaded.push(seq),
    }),
  )
  app.mount(host)
  mounted = app
  return { host, shown, restored, downloaded }
}

function rowOf(host: Element, seq: number) {
  const rows = [...host.querySelectorAll('section > div')]
  return rows[[named, automatic, lastWeek].findIndex((each) => each.seq === seq)]
}

function rowButton(host: Element, seq: number) {
  return rowOf(host, seq).querySelector<HTMLButtonElement>('button[aria-pressed]')!
}

function currentButton(host: Element) {
  return [...host.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Current version',
  )!
}

function linesOf(host: Element, seq: number) {
  return [...rowButton(host, seq).querySelectorAll('p')].map((line) => line.textContent)
}

describe('the versions list', () => {
  it('lists versions under their day, newest first, below Current version', () => {
    const { host } = mountList()
    const headings = [...host.querySelectorAll('h3')].map((heading) => heading.textContent)

    expect(host.querySelector('button')!.textContent?.trim()).toBe('Current version')
    expect(headings).toEqual(['Today', expect.stringMatching(/^(Oct 8|8 Oct)$/)])
  })

  it('names a named version, then who took it and when', () => {
    const { host } = mountList()

    expect(linesOf(host, named.seq)).toEqual([
      'Before review',
      expect.stringMatching(/^Ana Silva · (2:14\s?pm|14:14)$/i),
    ])
  })

  it('gives an automatic version its time, then only who took it', () => {
    const { host } = mountList()

    expect(linesOf(host, automatic.seq)).toEqual([
      expect.stringMatching(/^(9:05\s?am|09:05)$/i),
      'Ana Silva',
    ])
  })

  it('views a version on its row, and goes back on Current version', async () => {
    const { host, shown } = mountList()

    rowButton(host, automatic.seq).click()
    await nextTick()
    const viewing = [shown.value?.seq, rowButton(host, automatic.seq).getAttribute('aria-pressed')]
    currentButton(host).click()
    await nextTick()

    expect([viewing, shown.value, currentButton(host).getAttribute('aria-pressed')]).toEqual([
      [automatic.seq, 'true'],
      null,
      'true',
    ])
  })
})

describe("a version's actions", () => {
  function restoreOf(host: Element, seq: number) {
    return rowOf(host, seq).querySelector<HTMLButtonElement>('[aria-label="Restore this version"]')
  }

  it('restores the version on its row', () => {
    const { host, restored } = mountList()

    restoreOf(host, automatic.seq)!.click()

    expect(restored).toEqual([automatic.seq])
  })

  it('downloads the version on its row from its menu', () => {
    const { host, downloaded } = mountList()

    rowOf(host, lastWeek.seq).querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()

    expect(downloaded).toEqual([lastWeek.seq])
  })

  it('offers no Restore to someone who can’t restore', () => {
    const { host } = mountList({ canRestore: false })

    expect(restoreOf(host, named.seq)).toBeNull()
  })

  it('holds Restore while a restore runs', () => {
    const { host } = mountList({ isRestoring: true })

    expect(restoreOf(host, named.seq)!.disabled).toBe(true)
  })

  it('shows the viewed row’s actions without a hover, and hides the others’ until one', () => {
    const { host } = mountList({ previewed: named })

    const isHidden = [named, automatic].map(
      (each) => restoreOf(host, each.seq)!.parentElement!.closest('.invisible') !== null,
    )

    expect(isHidden).toEqual([false, true])
  })
})
