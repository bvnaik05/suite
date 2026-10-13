import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

vi.mock('@/apps/drive', () => ({
  driveDocumentIcon: () => ['file-icon-doc', 'text-ink-blue-6'],
  formatDriveBytes: (bytes: number) => `${bytes} B`,
  formatDriveListingDate: () => 'Just now',
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

async function openedPage(ready = (root: Element) => rowButton(root)) {
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
  await vi.waitFor(() => expect(ready(root)).not.toBeNull())
  return { root, router }
}

function emptyState(root: Element) {
  if (!root.textContent?.includes('No recovery copies')) {
    return null
  }

  return root
}

function rowButton(root: Element) {
  return root.querySelector<HTMLElement>('button[data-slot="list-row"]')!
}

afterEach(async () => {
  const copies = await listCopies()
  await Promise.all(copies.map(discardCopy))
  window.document.body.innerHTML = ''
})

describe('Writer recovery copies page', () => {
  it('lists each copy with its title, size and saved time', async () => {
    keepPageCopy('node-1', 'Plan', '<p>abc</p>')
    const { root } = await openedPage()

    const cells = [...rowButton(root).querySelectorAll('[data-slot="list-cell"]')]
    const texts = cells.map((cell) => cell.textContent!.trim())
    expect(texts.slice(0, 3)).toEqual(['Plan', '10 B', 'Just now'])
  })

  it('says so when the device keeps no copies', async () => {
    const { root } = await openedPage(emptyState)

    expect(rowButton(root)).toBeNull()
  })

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
