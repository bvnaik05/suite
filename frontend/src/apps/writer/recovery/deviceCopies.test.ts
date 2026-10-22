import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ref } from 'vue'
import * as yjs from 'yjs'

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

function deleteDatabase(name: string) {
  return new Promise((resolve) => {
    indexedDB.deleteDatabase(name).onsuccess = resolve
  })
}

beforeEach(() => localStorage.clear())

afterEach(async () => {
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
})
