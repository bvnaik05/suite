import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

vi.mock('@/apps/drive', () => ({
  formatDriveBytes: (bytes: number) => `${bytes} B`,
  loadDriveNodeSummary: async (node: string) => {
    if (node === 'gone') {
      throw new Error('Not found')
    }

    return { name: node, title: 'Plan', state: node === 'trashed' ? 'Trashed' : 'Active' }
  },
  driveNodeRoute: (node: { name: string }) => ({ path: `/d/${node.name}/plan` }),
}))

const { discardCopy, keepPageCopy, listCopies } = await import('./copies')
const { default: UnsavedWork } = await import('./UnsavedWork.vue')

async function openedPage() {
  const document = { render: () => null }
  const routes = [
    { path: '/drive/recovery', component: UnsavedWork },
    { path: '/d/:node/:slug', component: document },
  ]
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/drive/recovery')
  await router.isReady()

  const root = window.document.createElement('div')
  window.document.body.append(root)
  createApp({ render: () => h(RouterView) })
    .use(router)
    .mount(root)
  await vi.waitFor(() => expect(root.querySelector('li')).not.toBeNull())
  return { root, router }
}

function rowButton(root: Element) {
  return root.querySelector<HTMLElement>('li button')!
}

afterEach(async () => {
  const copies = await listCopies()
  await Promise.all(copies.map(discardCopy))
  window.document.body.innerHTML = ''
})

describe('Writer recovery copies page', () => {
  it('opens a copy in its document when the document can be opened', async () => {
    keepPageCopy('node-1', 'Plan', '<p>Typed while offline</p>')
    const [copy] = await listCopies()
    const { root, router } = await openedPage()

    rowButton(root).click()

    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/d/node-1/plan'))
    expect(router.currentRoute.value.query).toEqual({ recovery: copy.key })
  })

  it.each(['trashed', 'gone'])('shows a copy on the page when its document is %s', async (node) => {
    keepPageCopy(node, 'Plan', '<p>Typed while offline</p>')
    const { root, router } = await openedPage()

    rowButton(root).click()

    await vi.waitFor(() =>
      expect(root.querySelector('[aria-label="Recovery copy"]')).not.toBeNull(),
    )
    expect(router.currentRoute.value.path).toBe('/drive/recovery')
    expect(root.querySelector('[aria-label="Recovery copy"]')!.textContent).toBe(
      'Typed while offline',
    )
  })
})
