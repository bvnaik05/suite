import { createDocument, getSchema } from '@tiptap/core'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import * as yjs from 'yjs'

import { api, client } from '@/api'
import type { DocumentSession } from '@/apps/drive'
import { BODY_FIELD } from '@/apps/writer/collab'
import { writerAdapter } from '@/apps/writer/collab/adapter'
import { writerRender } from '@/apps/writer/collab/render'
import { writerSchema } from '@/apps/writer/schema'
import type { WriterDocumentRow } from '@/apps/writer/surface/writerDocument'
import { openSignedInDeviceStore } from '@/platform/collab'

import { keepPageCopy } from './copies'

/**
 * The old editor's work on this device: its Yjs store `fdoc-<name>` and its
 * draft in the `Writer` database. Each open keeps what the row lacks as a
 * recovery copy, once, and never deletes the old stores, which a stale tab may
 * still write to.
 */
type OldRow = Pick<
  WriterDocumentRow,
  'name' | 'content' | 'html' | 'content_modified' | 'conversion'
>

interface OldDraft {
  val?: unknown
  saved?: unknown
}

const KEPT_PREFIX = 'suite:writer-device-copied:'
const schema = getSchema(writerSchema())

/** Keeps the old editor's unsaved work on this device as recovery copies of the document. */
export async function keepDeviceCopies(session: DocumentSession, row: OldRow) {
  await keepYjsCopy(session, row)
  await keepDraftCopy(session.nodeId, session.title.value, row)
}

async function keepYjsCopy(session: DocumentSession, row: OldRow) {
  const updates = await readFrom<unknown[]>(`fdoc-${row.name}`, 'updates', (store) =>
    store.getAll(),
  )
  if (!updates?.length) {
    return
  }

  const base = rowDoc(await oldContent(session, row))
  const merged = mergedDoc(base, updates)
  const vector = yjs.encodeStateVector(merged)
  if (!isAhead(vector, yjs.encodeStateVector(base))) {
    return
  }

  const node = session.nodeId
  const key = `yjs:${await digest(vector)}`
  const state = yjs.encodeStateAsUpdate(merged)
  await keepOnce(node, key, () => keepState(node, session.title.value, state))
}

// A converted row's `content` is the new lineage, so the base is the old body conversion kept
async function oldContent(session: DocumentSession, row: OldRow) {
  if (row.conversion) {
    return row.content
  }

  const context = session.credentials.context
  const old = await client.query(
    api.writer.documents.oldBody,
    { node: session.nodeId },
    { context },
  )
  return old.content
}

function mergedDoc(base: yjs.Doc, updates: unknown[]) {
  const merged = new yjs.Doc()
  yjs.applyUpdate(merged, yjs.encodeStateAsUpdate(base))
  for (const update of updates) {
    // An update Yjs can't read is skipped, not copied
    try {
      yjs.applyUpdate(merged, update as Uint8Array)
    } catch {
      continue
    }
  }

  return merged
}

async function keepDraftCopy(node: string, title: string, row: OldRow) {
  const draft = await readFrom<OldDraft>('Writer', 'content', (store) => store.get(row.name))
  const html = draft?.val
  const saved = draft?.saved
  if (typeof html !== 'string' || !(saved instanceof Date) || html === (row.html ?? '')) {
    return
  }

  // A save after the draft holds what the person meant to keep
  if (row.content_modified && saved <= new Date(row.content_modified)) {
    return
  }

  const doc = prosemirrorJSONToYDoc(schema, createDocument(html, schema).toJSON(), BODY_FIELD)
  const stamp = saved.toISOString()
  await keepOnce(node, `draft:${stamp}`, () => keepState(node, title, yjs.encodeStateAsUpdate(doc)))
}

// The row's old body, or none when it can't be read
function rowDoc(content: string | null | undefined) {
  const doc = new yjs.Doc()
  if (!content) {
    return doc
  }

  try {
    yjs.applyUpdate(
      doc,
      Uint8Array.from(atob(content), (char) => char.charCodeAt(0)),
    )
  } catch {
    return new yjs.Doc()
  }

  return doc
}

function isAhead(device: Uint8Array, row: Uint8Array) {
  const rowClocks = yjs.decodeStateVector(row)
  const deviceClocks = [...yjs.decodeStateVector(device)]
  return deviceClocks.some(([id, clock]) => clock > (rowClocks.get(id) ?? 0))
}

async function digest(bytes: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
  return btoa(String.fromCharCode(...hash))
}

// Each piece of old work is kept once, so a discarded copy doesn't come back
async function keepOnce(node: string, key: string, keep: () => Promise<boolean>) {
  const storageKey = `${KEPT_PREFIX}${node}`
  const kept: string[] = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
  if (kept.includes(key) || !(await keep())) {
    return
  }

  localStorage.setItem(storageKey, JSON.stringify([...kept, key]))
}

async function keepState(node: string, title: string, state: Uint8Array) {
  const store = await openSignedInDeviceStore(writerAdapter.app)
  // A page copy isn't counted as kept: a later one of this tab load writes over it
  if (!store) {
    const doc = new yjs.Doc()
    yjs.applyUpdate(doc, state)
    keepPageCopy(node, title, writerRender(doc).html)
    return false
  }

  const id = crypto.randomUUID()
  const sid = `old-editor-${id}`
  const entry = { doc: node, sid, seq: 0, bytes: state, sha: '', seenRev: 0 }
  try {
    await store.recover(node, [sid], 'old-editor', [entry], { state, title })
  } catch {
    return false
  }

  return true
}

// Reads one store of a database that already exists, never creating it
async function readFrom<T>(
  name: string,
  storeName: string,
  read: (store: IDBObjectStore) => IDBRequest,
): Promise<T | undefined> {
  const db = await openExisting(name)
  if (!db) {
    return undefined
  }

  try {
    if (!db.objectStoreNames.contains(storeName)) {
      return undefined
    }

    return await new Promise<T | undefined>((resolve) => {
      const request = read(db.transaction(storeName).objectStore(storeName))
      request.onsuccess = () => resolve(request.result as T)
      request.onerror = () => resolve(undefined)
    })
  } finally {
    db.close()
  }
}

function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open(name)
    // A database that doesn't exist yet would be made here, so the open is undone
    request.onupgradeneeded = () => request.transaction?.abort()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}
