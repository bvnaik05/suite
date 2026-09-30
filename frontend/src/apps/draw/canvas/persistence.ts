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
export const drawingConflict = ref(false)
export const drawingLoadError = ref(false)
export const copyingDraft = ref(false)
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
async function draft(action: 'get' | 'put' | 'delete', value?: Drawing, draftKey = key) {
  const db = await draftStore()
  return new Promise<Drawing | undefined>((resolve, reject) => {
    const tx = db.transaction('drafts', action === 'get' ? 'readonly' : 'readwrite')
    const store = tx.objectStore('drafts')
    const operation = action === 'get' ? store.get(draftKey) : action === 'put' ? store.put(value, draftKey) : store.delete(draftKey)
    tx.oncomplete = () => resolve(action === 'get' ? operation.result : undefined)
    tx.onerror = () => reject(tx.error)
  })
}
export async function loadDrawing(): Promise<Scene | undefined> {
  await saveDrawing()
  drawingLoading.value = true
  drawingConflict.value = false
  drawingLoadError.value = false
  ready = false
  dirty = false
  pending = undefined
  modified = ''
  key = ''
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
    const drawing = recovered ?? { title: doc.title, content: typeof doc.content === 'string' ? JSON.parse(doc.content) : doc.content }
    drawing.content = parseScene(drawing.content)
    drawingConflict.value = Boolean(recovered && recovered.baseModified !== modified)
    ready = !drawingConflict.value
    dirty = Boolean(recovered)
    if (drawingConflict.value) {
      pending = recovered
      toast.warning('The saved drawing changed since this draft. Save a recovered copy to continue editing.')
    }
    drawingTitle.value = drawing.title
    if (recovered && !drawingConflict.value) setTimeout(() => queueSave(drawing.content), 0)
    return drawing.content
  } catch (error) {
    drawingLoadError.value = true
    toast.error('Could not load drawing', { description: error instanceof TypeError ? 'Please check your connection and try again.' : error instanceof Error ? error.message : 'Please try again.' })
  } finally { queueMicrotask(() => { drawingLoading.value = drawingConflict.value || drawingLoadError.value }) }
}
export async function saveRecoveredCopy() {
  if (!drawingConflict.value || !pending || copyingDraft.value) return
  copyingDraft.value = true
  try {
    const result = await drawRequest('/api/resource/Drawing', 'POST', {
      doctype,
      title: pending.title,
      content: JSON.stringify(pending.content),
    })
    await draft('delete').catch(() => {})
    dirty = false
    location.href = `/draw/editor?drawing=${encodeURIComponent(result.data.name)}`
  } catch (error) {
    copyingDraft.value = false
    toast.error('Could not save recovered copy', { description: error instanceof Error ? error.message : 'Please try again.' })
  }
}
export function queueSave(scene: Scene) {
  if (drawingLoading.value) return
  pending = { title: drawingTitle.value.trim() || 'Untitled Drawing', content: parseScene(scene), baseModified: modified }
  dirty = true
  if (key) void draft('put', pending).catch(() => { toast.error('Draft recovery unavailable. Keep this tab open.') })
  if (!ready) return
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
          await draft('delete').catch(() => {})
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
