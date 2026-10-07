import { ref } from 'vue'
import { toast } from 'frappe-ui'
import { parseScene, type Scene } from './selection'
import { drawRequest } from './request'

type Drawing = { title: string; content: Scene; baseModified?: string }
type DrawingDocument = { title: string; content: string | Scene; modified: string }
const doctype = 'Drawing'
export const drawingTitle = ref('Untitled Drawing')
let user = '', name = '', modified = '', key = ''
export const drawingLoading = ref(true)
let ready = false, dirty = false
let pending: Drawing | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let inFlight: Promise<void> | undefined
let database: IDBDatabase | undefined

function documentPath() {
  return `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`
}
async function draftStore() {
  if (database) return database
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('draw-next-drafts', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('drafts')
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  return database
}
async function draft(action: 'get' | 'put' | 'delete', value?: Drawing) {
  const db = await draftStore()
  return new Promise<Drawing | undefined>((resolve, reject) => {
    const tx = db.transaction('drafts', action === 'get' ? 'readonly' : 'readwrite')
    const store = tx.objectStore('drafts')
    const operation = action === 'get' ? store.get(key) : action === 'put' ? store.put(value, key) : store.delete(key)
    tx.oncomplete = () => resolve(action === 'get' ? operation.result : undefined)
    tx.onerror = () => reject(tx.error)
  })
}
export async function loadDrawing(): Promise<Scene | undefined> {
  clearTimeout(timer)
  drawingLoading.value = true
  ready = false
  dirty = false
  pending = undefined
  modified = ''
  try {
    const url = new URL(location.href)
    name = url.searchParams.get('drawing') ?? ''
    if (!name) { location.replace('/draw/'); return }
    const [auth, result] = await Promise.all([
      drawRequest('/api/method/frappe.auth.get_logged_user'),
      drawRequest(documentPath()),
    ])
    user = auth.message
    if (!user || user === 'Guest') throw new Error('Sign in to Frappe to save drawings.')
    key = `${user}:${name}`
    const recovered = await draft('get').catch(() => undefined)
    const doc = result.data as DrawingDocument
    modified = doc.modified
    const drawing = recovered ?? { title: doc.title, content: parseScene(typeof doc.content === 'string' ? JSON.parse(doc.content) : doc.content) }
    if (drawing) drawing.content = parseScene(drawing.content)
    const conflict = recovered && recovered.baseModified !== modified
    if (conflict) modified = recovered.baseModified ?? ''
    ready = !conflict
    dirty = Boolean(recovered)
    if (conflict) toast.warning('Draft conflicts with the saved drawing. Copy it into a new drawing before editing.')
    if (drawing) {
      drawingTitle.value = drawing.title
      if (recovered && !conflict) setTimeout(() => queueSave(drawing.content), 0)
      return parseScene(drawing.content)
    }
  } catch (error) {
    toast.error('Could not load drawing', { description: error instanceof TypeError ? 'Please check your connection and try again.' : error instanceof Error ? error.message : 'Please try again.' })
  } finally { queueMicrotask(() => { drawingLoading.value = false }) }
}
export function queueSave(scene: Scene) {
  if (drawingLoading.value) return
  dirty = true
  pending = { title: drawingTitle.value.trim() || 'Untitled Drawing', content: parseScene(scene), baseModified: modified }
  if (!ready) { if (key) void draft('put', pending).catch(() => { toast.error('Draft recovery unavailable. Keep this tab open.') }); return }
  void draft('put', pending).catch(() => { toast.error('Draft recovery unavailable. Keep this tab open.') })
  clearTimeout(timer)
  timer = setTimeout(saveDrawing, 600)
}
export async function saveDrawing() {
  clearTimeout(timer)
  timer = undefined
  if (inFlight) return inFlight
  if (!ready || !pending) return
  const operation = (async () => {
    while (ready) {
      const next = pending
      if (!next) return
      try {
        const document = { title: next.title, content: JSON.stringify(next.content), ...(modified ? { modified } : {}) }
        const result = await drawRequest(modified ? documentPath() : `/api/resource/${encodeURIComponent(doctype)}`, modified ? 'PUT' : 'POST', modified ? document : { doctype, name, ...document })
        modified = result.data.modified
        if (pending && pending !== next) { pending.baseModified = modified; await draft('put', pending) }
        if (pending === next) {
          void draft('delete').catch(() => {})
          if (pending === next) { pending = undefined; dirty = false }
        }
      } catch (error) {
        toast.error('Could not save drawing', { description: error instanceof TypeError ? 'Please check your connection. Your changes are kept in this browser.' : error instanceof Error ? error.message : 'Your changes are kept in this browser.' })
        return
      }
      if (pending === next) return
    }
  })()
  inFlight = operation
  await operation
  if (inFlight === operation) inFlight = undefined
}
export function warnUnsaved(event: BeforeUnloadEvent) {
  if (dirty) { event.preventDefault(); event.returnValue = '' }
}
window.addEventListener('online', () => { if (pending) void saveDrawing() })
