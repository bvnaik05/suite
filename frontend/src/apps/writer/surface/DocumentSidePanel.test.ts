import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'

import type { DocumentSession } from '@/apps/drive'

import DocumentSidePanel from './DocumentSidePanel.vue'

vi.mock('frappe-ui', async () => {
  const { defineComponent: define, h: render, ref: state } = await import('vue')
  const emptyComponent = { render: () => null }
  return {
    Avatar: emptyComponent,
    Textarea: emptyComponent,
    Button: define({
      props: { label: String },
      emits: ['click'],
      setup:
        (props, { emit }) =>
        () =>
          render('button', { onClick: () => emit('click') }, props.label),
    }),
    TextInput: define({
      props: { modelValue: String },
      emits: ['update:modelValue'],
      setup(props, { emit, expose }) {
        const input = state<HTMLInputElement | null>(null)
        expose({ focus: () => input.value?.focus() })
        function write(event: Event) {
          emit('update:modelValue', (event.target as HTMLInputElement).value)
        }

        return () => render('input', { ref: input, value: props.modelValue, onInput: write })
      },
    }),
    toast: { success: vi.fn(), error: vi.fn() },
  }
})

vi.mock('@/apps/drive', async () => {
  const { defineComponent: define, ref: state } = await import('vue')
  return {
    DriveCommentAuthor: define({ setup: () => () => null }),
    formatDriveDateTime: String,
    GUEST_NAME_LIMIT: 140,
    useDriveGuestName: () => ({
      shown: state(false),
      text: state(''),
      atLimit: state(false),
      maxLength: 140,
      take: () => '',
    }),
  }
})

interface NamingPanel {
  startNamingVersion(): Promise<void>
}

let mounted: App | null = null

afterEach(() => {
  mounted?.unmount()
  document.body.replaceChildren()
})

// The Versions panel over a session that records the versions taken, after the edits are saved
async function openVersionsPanel() {
  const steps: string[] = []
  const session = {
    comments: {},
    versions: {
      list: async () => ({ rows: [], next_cursor: null }),
      create: async (kind: string, label: string) => {
        steps.push(`took ${kind} "${label}"`)
      },
    },
  } as unknown as DocumentSession
  const panel = ref<NamingPanel | null>(null)
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(() =>
    h(DocumentSidePanel, {
      ref: panel,
      panel: 'versions',
      previewedVersion: null,
      session,
      canComment: true,
      threads: [],
      places: null,
      refreshThreads: async () => {},
      saveFirst: async () => {
        steps.push('saved')
      },
    }),
  )
  app.mount(host)
  mounted = app
  await panel.value?.startNamingVersion()
  return { steps, host }
}

function nameBox() {
  return document.querySelector<HTMLInputElement>('input[aria-label="Version name"]')
}

async function press(key: string) {
  nameBox()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  await nextTick()
}

async function type(text: string) {
  const box = nameBox()
  if (!box) {
    throw new Error('no name box')
  }

  box.value = text
  box.dispatchEvent(new Event('input'))
  await nextTick()
}

async function settled() {
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

describe('naming a version in the Versions panel', () => {
  it('opens a name box at the top with the cursor in it and the keys to use', async () => {
    const { host } = await openVersionsPanel()

    expect([document.activeElement === nameBox(), host.textContent]).toEqual([
      true,
      expect.stringContaining('Enter to save · Esc to cancel'),
    ])
  })

  it('saves the edits, then takes a version under the typed name, on Enter', async () => {
    const { steps } = await openVersionsPanel()

    await type('  Before the review ')
    await press('Enter')
    await settled()

    expect([steps, nameBox()]).toEqual([['saved', 'took named "Before the review"'], null])
  })

  it('takes nothing and closes the box on Esc', async () => {
    const { steps } = await openVersionsPanel()

    await type('Before the review')
    await press('Escape')
    await settled()

    expect([steps, nameBox()]).toEqual([[], null])
  })

  it('takes nothing and closes the box on Enter with an empty name', async () => {
    const { steps } = await openVersionsPanel()

    await type('   ')
    await press('Enter')
    await settled()

    expect([steps, nameBox()]).toEqual([[], null])
  })
})
