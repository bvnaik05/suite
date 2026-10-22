import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import * as yjs from 'yjs'

import { client } from '@/api'
import type { DocumentSession } from '@/apps/drive'
import { BODY_FIELD } from '@/apps/writer/collab/field'

import { discardCopy, listCopies } from './copies'
import { keepDeviceCopies } from './deviceCopies'

const NODE = 'drive-file-1'

const session = {
  nodeId: NODE,
  title: ref('Plans'),
  credentials: { context: {} },
} as unknown as DocumentSession

const row = { content: null, html: '<p>saved</p>', content_modified: null, conversion: 'done' }

function openDatabase(name: string, upgrade: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => upgrade(request.result)
    request.onsuccess = () => resolve(request.result)
  })
}

function put(db: IDBDatabase, storeName: string, value: unknown, key?: string) {
  return new Promise<void>((resolve) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(value, key)
    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
  })
}

// y-indexeddb's layout: database `fdoc-<id>`, updates in an auto-numbered `updates` store
async function writeOldYjsStore(id: string, words: string) {
  const doc = new yjs.Doc()
  const paragraph = new yjs.XmlElement('paragraph')
  paragraph.insert(0, [new yjs.XmlText(words)])
  doc.getXmlFragment(BODY_FIELD).insert(0, [paragraph])
  const db = await openDatabase(`fdoc-${id}`, (created) =>
    created.createObjectStore('updates', { autoIncrement: true }),
  )
  await put(db, 'updates', yjs.encodeStateAsUpdate(doc))
}

// NonCollabEditor's layout: the `Writer` database, one draft per Drive file name
async function writeOldDraft(id: string, html: string) {
  const db = await openDatabase('Writer', (created) => created.createObjectStore('content'))
  await put(db, 'content', { val: html, saved: new Date() }, id)
}

// A body the row saved, and the old store's bytes: that body, plus `extra` typed after it
function oldBodyAndStore(words: string, extra = '') {
  const doc = new yjs.Doc()
  const paragraph = new yjs.XmlElement('paragraph')
  const text = new yjs.XmlText(words)
  paragraph.insert(0, [text])
  doc.getXmlFragment(BODY_FIELD).insert(0, [paragraph])
  const saved = yjs.encodeStateAsUpdate(doc)
  if (extra) {
    text.insert(words.length, extra)
  }

  return { content: btoa(String.fromCharCode(...saved)), stored: yjs.encodeStateAsUpdate(doc) }
}

async function writeStoredBytes(id: string, bytes: Uint8Array) {
  const db = await openDatabase(`fdoc-${id}`, (created) =>
    created.createObjectStore('updates', { autoIncrement: true }),
  )
  await put(db, 'updates', bytes)
}

async function writeDraftSavedAt(id: string, html: string, saved: Date) {
  const db = await openDatabase('Writer', (created) => created.createObjectStore('content'))
  await put(db, 'content', { val: html, saved }, id)
}

async function keptTexts() {
  return (await listCopies(NODE)).map((copy) => copy.text)
}

function deleteDatabase(name: string) {
  return new Promise((resolve) => {
    indexedDB.deleteDatabase(name).onsuccess = resolve
  })
}

beforeEach(() => localStorage.clear())

afterEach(async () => {
  vi.restoreAllMocks()
  const copies = await listCopies()
  await Promise.all(copies.map(discardCopy))
  await deleteDatabase(`fdoc-${NODE}`)
  await deleteDatabase('Writer')
})

describe('keeping the old editor work on this device', () => {
  it('keeps the old collaborative editor work stored under the Drive file name', async () => {
    await writeOldYjsStore(NODE, 'typed offline')

    await keepDeviceCopies(session, row)

    const copies = await listCopies(NODE)
    expect(copies.map((copy) => copy.text)).toEqual(['typed offline'])
  })

  it('keeps the old plain editor draft stored under the Drive file name', async () => {
    await writeOldDraft(NODE, '<p>draft never saved</p>')

    await keepDeviceCopies(session, row)

    const copies = await listCopies(NODE)
    expect(copies.map((copy) => copy.text)).toEqual(['draft never saved'])
  })

  it('keeps what the old store holds beyond the saved body', async () => {
    const { content, stored } = oldBodyAndStore('saved words', ' and more')
    await writeStoredBytes(NODE, stored)

    await keepDeviceCopies(session, { ...row, content })

    expect(await keptTexts()).toEqual(['saved words and more'])
  })

  it('keeps nothing when the old store holds only the saved body', async () => {
    const { content, stored } = oldBodyAndStore('saved words')
    await writeStoredBytes(NODE, stored)

    await keepDeviceCopies(session, { ...row, content })

    expect(await keptTexts()).toEqual([])
  })

  it('keeps nothing when the draft is the saved body', async () => {
    await writeOldDraft(NODE, row.html)

    await keepDeviceCopies(session, row)

    expect(await keptTexts()).toEqual([])
  })

  it('keeps a draft only when it is newer than the last save', async () => {
    const saved = new Date('2026-10-01T10:00:00Z')
    const draft = '<p>draft</p>'

    for (const [modified, kept] of [
      ['2026-10-01T10:00:01Z', []],
      ['2026-10-01T10:00:00Z', []],
      ['2026-10-01T09:59:59Z', ['draft']],
    ] as const) {
      localStorage.clear()
      await writeDraftSavedAt(NODE, draft, saved)

      await keepDeviceCopies(session, { ...row, content_modified: modified })

      expect(await keptTexts(), modified).toEqual(kept)
      await Promise.all((await listCopies()).map(discardCopy))
    }
  })

  it('keeps each piece of old work once across opens, even after it is discarded', async () => {
    await writeOldYjsStore(NODE, 'typed offline')
    await writeOldDraft(NODE, '<p>draft never saved</p>')

    await keepDeviceCopies(session, row)
    await keepDeviceCopies(session, row)
    expect((await keptTexts()).sort()).toEqual(['draft never saved', 'typed offline'])

    await Promise.all((await listCopies()).map(discardCopy))
    await keepDeviceCopies(session, row)
    expect(await keptTexts()).toEqual([])
  })

  it('compares a document not yet converted with the old body the server still holds', async () => {
    const { content, stored } = oldBodyAndStore('saved words')
    await writeStoredBytes(NODE, stored)
    const live = { ...row, conversion: undefined }
    const query = vi.spyOn(client, 'query').mockResolvedValueOnce({ content })

    await keepDeviceCopies(session, live)

    expect(query.mock.calls[0]?.[1]).toEqual({ node: NODE })
    expect(await keptTexts()).toEqual([])

    query.mockResolvedValueOnce({})
    await keepDeviceCopies(session, live)

    expect(await keptTexts()).toEqual(['saved words'])
  })
})
