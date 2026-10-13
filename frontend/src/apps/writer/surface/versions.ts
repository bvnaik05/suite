import type { JSONContent } from '@tiptap/core'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import * as Y from 'yjs'

import { BODY_FIELD } from '@/apps/writer/collab'
import { storedFirstTabLabel } from '@/apps/writer/extensions/tabs'

/** What one stored version shows: HTML, or a document read from its Yjs state, and its first tab's label. */
export interface StoredVersion {
  content: string | JSONContent
  firstTabLabel: string | null
}

/** Reads a stored Writer version by its schema. Throws on bytes it cannot show. */
export async function readVersion(bytes: Uint8Array): Promise<StoredVersion> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const text = decoder.decode(bytes)
  let payload: unknown = null
  try {
    payload = JSON.parse(text)
  } catch {
    // Migrated history is raw HTML.
  }

  const isRecord = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
  if (!isRecord) {
    return { content: text, firstTabLabel: null }
  }

  const version = payload as Record<string, unknown>
  const isHtmlVersion = version.schema === 'writer-document/1'
  const hasContent = typeof version.content === 'string' && version.content !== ''
  const isKnownCollab = [0, 1, false, true, undefined].includes(
    version.collab as number | boolean | undefined,
  )
  if (isHtmlVersion && hasContent && typeof version.html === 'string' && isKnownCollab) {
    return { content: version.html, firstTabLabel: null }
  }

  const isYjsVersion = version.schema === 'writer-document/2' && version.codec === 'yjs1'
  if (isYjsVersion && typeof version.state === 'string') {
    return readState(version.state)
  }

  throw new Error('This version cannot be read.')
}

async function readState(state: string): Promise<StoredVersion> {
  const ydoc = new Y.Doc()
  try {
    const update = await gunzip(fromBase64(state))
    Y.applyUpdate(ydoc, update)
    const content = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(BODY_FIELD))
    return { content, firstTabLabel: storedFirstTabLabel(ydoc) }
  } finally {
    ydoc.destroy()
  }
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const compressed = new Response(bytes).body!
  const stream = compressed.pipeThrough(new DecompressionStream('gzip'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}
