import { getHTMLFromFragment, getSchema, getText, getTextSerializersFromSchema } from '@tiptap/core'
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import type * as Y from 'yjs'

import { BODY_FIELD } from '@/apps/writer/collab/field'
import { writerSchema } from '@/apps/writer/schema'

const schema = getSchema(writerSchema())

// The readable copy of a Writer document: its body as HTML, and the text a reader sees, a line per block
export function writerRender(doc: Y.Doc) {
  const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(BODY_FIELD), schema)
  const textSerializers = getTextSerializersFromSchema(schema)
  return {
    html: getHTMLFromFragment(root.content, schema),
    text: getText(root, { blockSeparator: '\n', textSerializers }),
  }
}
