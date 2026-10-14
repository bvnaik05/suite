import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import { useYjs } from './useYjs'

vi.mock('y-webrtc', async () => {
  const { Awareness } = await import('y-protocols/awareness')
  class WebrtcProvider {
    awareness: InstanceType<typeof Awareness>
    disconnect = vi.fn()
    destroy = vi.fn()

    constructor(_room: string, doc: Y.Doc) {
      this.awareness = new Awareness(doc)
    }
  }

  return { WebrtcProvider }
})

type Tab = ReturnType<typeof useYjs> & { edited: Ref<boolean> }

const tabs: Tab[] = []
afterEach(() => {
  for (const tab of tabs.splice(0)) {
    tab.cleanup()
  }
})

// An old editor's tab on document `id`, as TextEditor opens it
function openTab(id: string): Tab {
  const document = {
    doc: { name: id, content: '', ycomments: '' },
    saveDoc: { run: vi.fn(async () => {}) },
    saveComments: { run: vi.fn(async () => {}) },
  } as unknown as Parameters<typeof useYjs>[1]
  const edited = ref(false)
  const tab = { ...useYjs(id, document, ref(null), edited), edited }
  tabs.push(tab)
  return tab
}

async function loadedTab(id: string) {
  const tab = openTab(id)
  await vi.waitFor(() => expect(tab.loaded.value).toBe(true))
  return tab
}

function type(tab: Tab, words: string) {
  const text = tab.doc.getText('body')
  tab.doc.transact(() => text.insert(text.length, words), 'editor')
}

// What a later open of document `id` replays from this device
async function storedText(id: string) {
  const doc = new Y.Doc()
  const store = new IndexeddbPersistence(`fdoc-${id}`, doc)
  await store.whenSynced
  await store.destroy()
  return doc.getText('body').toString()
}

// The old editor opens a logged document when Writer collaboration is off or its log can't be
// read (R155 b); its refused save is then kept as a recovery copy
describe("the old editor's device store once a refused save is kept", () => {
  it('replays nothing into a later open, and the tab leaves the room', async () => {
    const tab = await loadedTab('doc-replay')
    type(tab, 'Old editor line')
    const before = await storedText('doc-replay')

    await tab.forgetStoredEdits()

    expect([before, await storedText('doc-replay')]).toEqual(['Old editor line', ''])
    expect(tab.provider.disconnect).toHaveBeenCalled()
  })

  it('still stores and saves what another old tab types after the clear', async () => {
    const [refused, sibling] = [await loadedTab('doc-sibling'), await loadedTab('doc-sibling')]
    type(refused, 'Refused line')

    await refused.forgetStoredEdits()
    await new Promise((resolve) => setTimeout(resolve, 50))
    type(sibling, 'Typed after')

    expect(sibling.edited.value).toBe(true)
    expect(await storedText('doc-sibling')).toBe('Typed after')
  })

  it('keeps the store when the copy was taken before the store loaded', async () => {
    const seeded = await loadedTab('doc-early')
    type(seeded, 'Stored line')
    seeded.cleanup()

    const tab = openTab('doc-early')
    await tab.forgetStoredEdits()
    await vi.waitFor(() => expect(tab.loaded.value).toBe(true))

    expect(await storedText('doc-early')).toBe('Stored line')
  })
})
