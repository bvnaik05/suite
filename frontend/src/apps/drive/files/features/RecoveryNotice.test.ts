import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

import { DOCUMENT_TYPES_KEY, type UnsavedCopy } from '@/platform/contracts'

vi.mock('frappe-ui', async () => ({
  Alert: (await import('../../../../../../node_modules/frappe-ui/src/components/Alert/Alert.vue'))
    .default,
}))

const { default: RecoveryNotice } = await import('./RecoveryNotice.vue')

let kept: UnsavedCopy[] = []

async function openedNotice() {
  const routes = [
    { path: '/drive', component: RecoveryNotice },
    { path: '/drive/recovery', component: { render: () => null } },
  ]
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/drive')
  await router.isReady()

  const writer = { key: 'writer', listUnsavedCopies: async () => kept }
  const root = document.createElement('div')
  document.body.append(root)
  createApp({ render: () => h(RouterView) })
    .provide(DOCUMENT_TYPES_KEY, [writer] as never)
    .use(router)
    .mount(root)
  for (let tick = 0; tick < 5; tick++) {
    await new Promise((done) => setTimeout(done))
  }

  return { root, router }
}

function button(root: Element, name: string) {
  const buttons = [...root.querySelectorAll('button')]
  return buttons.find((found) => (found.textContent ?? found.ariaLabel)?.includes(name))
}

beforeEach(() => localStorage.clear())

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Drive recovery notice', () => {
  it('counts documents, not copies, and Review opens the recovery copies page', async () => {
    kept = [
      { key: 'a', document: 'node-1' },
      { key: 'b', document: 'node-1' },
      { key: 'c', document: 'node-2' },
    ]
    const { root, router } = await openedNotice()

    expect(root.textContent).toContain("2 documents have changes that couldn't be saved")
    const review = root.querySelector('[data-layout="banner"] button')!
    expect([
      review.textContent?.trim(),
      review.closest('[data-color]')?.getAttribute('data-color'),
    ]).toEqual(['Review', 'gray'])
    button(root, 'Review')!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/drive/recovery'))
  })

  it('names a single document in the singular', async () => {
    kept = [{ key: 'a', document: 'node-1' }]
    const { root } = await openedNotice()

    expect(root.textContent).toContain("1 document has changes that couldn't be saved")
  })

  it('shows nothing when the device keeps no copies', async () => {
    kept = []
    const { root } = await openedNotice()

    expect(root.querySelector('[role="status"]')).toBeNull()
    expect(root.textContent).toBe('')
  })

  it('stays dismissed until a new copy is kept', async () => {
    kept = [{ key: 'a', document: 'node-1' }]
    const first = await openedNotice()
    first.root.querySelector<HTMLElement>('[aria-label="Dismiss"]')!.click()
    await new Promise((done) => setTimeout(done))
    expect(first.root.textContent).toBe('')

    const again = await openedNotice()
    expect(again.root.textContent).toBe('')

    kept = [...kept, { key: 'b', document: 'node-1' }]
    const afterNewCopy = await openedNotice()
    expect(afterNewCopy.root.textContent).toContain('1 document has')
  })

  it('still shows and dismisses where the browser blocks storage', async () => {
    kept = [{ key: 'a', document: 'node-1' }]
    const blocked = vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })
    const { root } = await openedNotice()
    expect(root.textContent).toContain('1 document has')

    root.querySelector<HTMLElement>('[aria-label="Dismiss"]')!.click()
    await new Promise((done) => setTimeout(done))
    blocked.mockRestore()
    expect(root.textContent).toBe('')
  })
})
