import { Editor, generateJSON, getSchema } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Heading from '@tiptap/extension-heading'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  mergeUpdates,
  XmlElement,
  XmlText,
} from 'yjs'

import { convertLegacy, type LegacyBody } from '@/apps/writer/collab/conversion'
import { BODY_FIELD } from '@/apps/writer/collab/field'
import { convertOldMedia } from '@/apps/writer/collab/old-media'
import { HeadingAnchors } from '@/apps/writer/extensions/heading-anchors'
import { writerSchema } from '@/apps/writer/schema'

vi.mock('@tiptap/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tiptap/core')>()
  return { ...original, generateJSON: vi.fn(original.generateJSON) }
})

vi.mock('@/apps/writer/collab/old-media', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/apps/writer/collab/old-media')>()
  return { ...original, convertOldMedia: vi.fn(original.convertOldMedia) }
})

const schema = getSchema(writerSchema())
const MAX_STATE = 4 * 1024 * 1024
const SRC = '/private/files/chart.png'

// A thread as Drive's earlier editor kept it in the comment mark
const DRIVE_THREAD = JSON.stringify({
  uuid: 'u1',
  comments: [{ userName: 'Ann', userImage: null, time: 1700000000000, content: '<p>see</p>' }],
})

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

function yElement(name: string, ...children: (XmlElement | XmlText)[]) {
  const node = new XmlElement(name)
  node.insert(0, children)
  return node
}

function yParagraph(text: string) {
  return yElement('paragraph', new XmlText(text))
}

function yMarked(text: string, attributes: Record<string, unknown>) {
  const content = new XmlText()
  content.insert(0, text, attributes)
  return yElement('paragraph', content)
}

function yHeading(text: string, id?: string) {
  const node = yElement('heading', new XmlText(text))
  node.setAttribute('level', 2 as never)
  if (id) {
    node.setAttribute('data-toc-id', id)
  }

  return node
}

function oldMedia(attributes: Record<string, string>) {
  const node = new XmlElement('resizableMedia')
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value)
  }

  return node
}

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
}

function legacyDoc(...blocks: XmlElement[]) {
  const doc = new Doc()
  doc.getXmlFragment(BODY_FIELD).insert(0, blocks)
  return doc
}

function stored(doc: Doc): LegacyBody {
  return { content: toBase64(encodeStateAsUpdate(doc)), html: '', collab: 1 }
}

function convert(legacy: LegacyBody) {
  const result = convertLegacy(legacy, MAX_STATE)
  if (result.kind !== 'converted') {
    throw new Error(result.reason)
  }

  return result
}

function opened(state: Uint8Array) {
  const doc = new Doc()
  applyUpdate(doc, state)
  return doc
}

function bodyOf(state: Uint8Array) {
  const json = yXmlFragmentToProsemirrorJSON(opened(state).getXmlFragment(BODY_FIELD))
  return schema.nodeFromJSON(json).toJSON()
}

function paragraph(...content: object[]) {
  return { type: 'paragraph', content }
}

function words(text: string) {
  return paragraph({ type: 'text', text })
}

function page(...content: object[]) {
  return schema.nodeFromJSON({ type: 'doc', content }).toJSON()
}

// The ids the editor draws today on the old body's headings, read from the page
function drawnIds(doc: Doc) {
  const element = document.createElement('div')
  document.body.append(element)
  const content = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(BODY_FIELD))
  const extensions = [Document, Paragraph, Text, Heading, HeadingAnchors]
  const editor = new Editor({ element, extensions, content })
  editors.push(editor)
  const headings = [...editor.view.dom.querySelectorAll('h2')]
  return headings.map((heading) => heading.getAttribute('data-toc-id'))
}

function headingIds(state: Uint8Array) {
  const headings = bodyOf(state).content.filter(
    (block: { type: string }) => block.type === 'heading',
  )
  return headings.map((heading: { attrs: Record<string, unknown> }) => heading.attrs['data-toc-id'])
}

describe('convertLegacy', () => {
  it('keeps old images and videos, a video opening a list item after an empty paragraph', () => {
    const video = { src: '/files/demo.mp4', 'media-type': 'video', dataAlign: 'center' }
    const item = yElement('listItem', oldMedia(video))
    const doc = legacyDoc(
      yParagraph('before'),
      oldMedia({ src: SRC, 'media-type': 'img', alt: 'Sales chart' }),
      yElement('bulletList', item),
    )

    const result = convert(stored(doc))

    const shown = { type: 'video', attrs: { src: '/files/demo.mp4', align: 'center' } }
    const list = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [paragraph(), shown] }],
    }
    const image = { type: 'image', attrs: { src: SRC, alt: 'Sales chart', align: 'left' } }
    expect(bodyOf(result.state)).toEqual(page(words('before'), paragraph(image), list))
    expect(result.dropped).toEqual([])
    expect(result.from).toBe('yjs')
  })

  it('drops an old inline table of contents, records it and changes nothing else', () => {
    const doc = legacyDoc(yParagraph('one'), new XmlElement('tocNode'), yParagraph('two'))

    const result = convert(stored(doc))

    expect(bodyOf(result.state)).toEqual(page(words('one'), words('two')))
    expect(result.dropped).toEqual([{ kind: 'node', name: 'tocNode', text: '' }])
  })

  it('records a part the editor cannot hold together with its text', () => {
    const doc = legacyDoc(yParagraph('one'), yElement('callout', yParagraph('note')))

    const result = convert(stored(doc))

    expect(bodyOf(result.state)).toEqual(page(words('one')))
    expect(result.dropped).toEqual([{ kind: 'node', name: 'callout', text: 'note' }])
  })

  it('records a part the editor cannot hold that has an image in it', () => {
    const image = new XmlElement('image')
    image.setAttribute('src', SRC)
    const doc = legacyDoc(yParagraph('one'), yElement('callout', yElement('paragraph', image)))

    const result = convert(stored(doc))

    expect(bodyOf(result.state)).toEqual(page(words('one')))
    expect(result.dropped).toEqual([{ kind: 'node', name: 'callout', text: '' }])
  })

  it('records text Yjs holds back because the change it follows was never stored', () => {
    const writer = new Doc()
    const text = new XmlText('first')
    writer.getXmlFragment(BODY_FIELD).insert(0, [yElement('paragraph', text)])
    const before = encodeStateVector(writer)
    text.insert(5, ' second')
    const later = encodeStateAsUpdate(writer, before)
    const other = legacyDoc(yParagraph('kept'))
    const content = toBase64(mergeUpdates([encodeStateAsUpdate(other), later]))

    const result = convert({ content, html: '', collab: 1 })

    expect(bodyOf(result.state)).toEqual(page(words('kept')))
    expect(result.dropped).toEqual([{ kind: 'pending', text: ' second' }])
  })

  it('holds only the body, leaving the old users, docinfo and emptied annotations behind', () => {
    const doc = legacyDoc(yParagraph('one'))
    doc.getMap('users').set('a', 'Ann')
    doc.getMap('docinfo').set('title', 'Old')
    doc.getArray('docAnnotations').insert(0, ['note'])
    doc.getArray('docAnnotations').delete(0, 1)

    const result = convert(stored(doc))

    expect([...opened(result.state).share.keys()]).toEqual([BODY_FIELD])
  })

  it('converts a document saved without collaboration from its HTML', () => {
    const legacy = { ...stored(legacyDoc(yParagraph('stale'))), html: '<p>fresh</p>', collab: 0 }

    const result = convert(legacy)

    expect(bodyOf(result.state)).toEqual(page(words('fresh')))
    expect(result.from).toBe('html')
  })

  it('converts from the HTML when the stored Yjs bytes cannot be read', () => {
    const legacy = { content: btoa('\u0005broken'), html: '<p>fresh</p>', collab: 1 }

    const result = convert(legacy)

    expect(bodyOf(result.state)).toEqual(page(words('fresh')))
    expect(result.from).toBe('html')
  })

  it('gives headings the ids the editor draws for them today and keeps ids they had', () => {
    const doc = legacyDoc(
      yHeading('Intro'),
      yParagraph('body'),
      yHeading('Intro'),
      yHeading('Plan', 'kept-id'),
      yHeading(''),
    )
    const drawn = drawnIds(doc)

    const result = convert(stored(doc))

    expect(drawn[0]).toBeTruthy()
    expect(drawn[1]).toBeTruthy()
    expect(drawn[0]).not.toBe(drawn[1])
    expect(headingIds(result.state)).toEqual([drawn[0], drawn[1], 'kept-id', null])
  })

  it('changes nothing when a converted body is converted again', () => {
    const doc = legacyDoc(
      yHeading('Intro'),
      oldMedia({ src: SRC, 'media-type': 'img' }),
      new XmlElement('tocNode'),
    )
    const first = convert(stored(doc))

    const second = convert({ content: toBase64(first.state), html: '', collab: 1 })

    expect(bodyOf(second.state)).toEqual(bodyOf(first.state))
    expect(second.dropped).toEqual([])
  })

  it('refuses a body over the size cap', () => {
    const result = convertLegacy(stored(legacyDoc(yParagraph('one'))), 10)

    expect(result).toEqual({ kind: 'failed', reason: 'too_large' })
  })

  it('refuses a body that would lose text it does not record', () => {
    const legacy = { content: null, html: '<p>kept</p><script>gone()</script>', collab: 0 }

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('fails rather than falling back to the HTML when readable bytes break the conversion', () => {
    vi.mocked(convertOldMedia).mockImplementationOnce(() => {
      throw new Error('conversion bug')
    })
    const legacy = { ...stored(legacyDoc(yParagraph('typed'))), html: '<p>older</p>' }

    expect(() => convertLegacy(legacy, MAX_STATE)).toThrow('conversion bug')
  })

  it('keeps a mention saved in the HTML, its label counted as no lost text', () => {
    const mention =
      '<span class="mention" data-type="mention" data-id="x" data-label="Ann">@Ann</span>'
    const legacy = { content: null, html: `<p>hi ${mention}</p>`, collab: 0 }

    const result = convert(legacy)

    const shown = { type: 'mention', attrs: { id: 'x', label: 'Ann' } }
    expect(bodyOf(result.state)).toEqual(page(paragraph({ type: 'text', text: 'hi ' }, shown)))
    expect(result.dropped).toEqual([])
  })

  it('keeps a mention stored in the Yjs body', () => {
    const mention = new XmlElement('mention')
    mention.setAttribute('id', 'x')
    mention.setAttribute('label', 'Ann')
    const doc = legacyDoc(yElement('paragraph', new XmlText('hi '), mention))

    const result = convert(stored(doc))

    const shown = { type: 'mention', attrs: { id: 'x', label: 'Ann' } }
    expect(bodyOf(result.state)).toEqual(page(paragraph({ type: 'text', text: 'hi ' }, shown)))
    expect(result.dropped).toEqual([])
  })

  it('keeps a heading holding a non-breaking space and a line break', () => {
    const legacy = { content: null, html: '<h2>Big&nbsp;plan<br>today</h2>', collab: 0 }

    const result = convert(legacy)

    const [heading] = bodyOf(result.state).content
    expect(heading.content).toEqual([
      { type: 'text', text: 'Big\u00a0plan' },
      { type: 'hardBreak' },
      { type: 'text', text: 'today' },
    ])
  })

  it('keeps an image saved in the HTML', () => {
    const legacy = { content: null, html: `<p>one</p><p><img src="${SRC}"></p>`, collab: 0 }

    const result = convert(legacy)

    // The image rule reads a missing alignment as left, as the old editor showed it
    const image = { type: 'image', attrs: { src: SRC, align: 'left' } }
    expect(bodyOf(result.state)).toEqual(page(words('one'), paragraph(image)))
  })

  it('refuses HTML whose parse leaves out an image, which changes no text', () => {
    vi.mocked(generateJSON).mockImplementationOnce(() => ({ type: 'doc', content: [words('one')] }))
    const legacy = { content: null, html: `<p>one</p><p><img src="${SRC}"></p>`, collab: 0 }

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('refuses HTML holding media the editor has no place for', () => {
    const legacy = { content: null, html: '<p>a</p><iframe src="x"></iframe>', collab: 0 }

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it.each([
    {
      name: 'a Drive thread kept in its comment mark',
      mark: { comment: { comment: DRIVE_THREAD } },
    },
    { name: 'an annotation', mark: { annotation: { annotationID: 'a1' } } },
    { name: 'an overlapping annotation', mark: { 'annotation--Ab+/9xY=': { annotationID: 'a2' } } },
    { name: 'a comment with no id', mark: { comment: { commentId: null } } },
    { name: 'a comment with an empty id', mark: { comment: { commentId: '' } } },
    { name: 'a comment with a number for its id', mark: { comment: { commentId: 7 } } },
  ])('refuses a Yjs body holding $name, which no thread is made from yet', ({ mark }) => {
    const legacy = stored(legacyDoc(yMarked('see', mark)))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('refuses a Yjs body holding an annotation on a mention', () => {
    const mention = new XmlElement('mention')
    mention.setAttribute('id', 'x')
    mention.setAttribute('label', 'Ann')
    mention.setAttribute('annotation', { annotationID: 'a1' } as never)
    const legacy = stored(legacyDoc(yElement('paragraph', new XmlText('hi '), mention)))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('refuses a Yjs document whose annotations list holds threads', () => {
    const doc = legacyDoc(yParagraph('one'))
    doc.getArray('docAnnotations').insert(0, [{ id: 'a1' }])

    expect(convertLegacy(stored(doc), MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it.each([
    { name: 'a Drive thread kept in its comment mark', span: `data-comment='${DRIVE_THREAD}'` },
    { name: 'an annotation', span: 'data-annotation-id="a1"' },
  ])('refuses HTML holding $name', ({ span }) => {
    const legacy = { content: null, html: `<p><span ${span}>see</span></p>`, collab: 0 }

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('converts comments that carry their thread ids, in Yjs, as an overlapping copy and in HTML', () => {
    const yjs = stored(legacyDoc(yMarked('see', { comment: { commentId: 'c1' } })))
    const overlap = stored(legacyDoc(yMarked('see', { 'comment--a+/=bC9z': { commentId: 'c2' } })))
    const html = { content: null, html: '<p><span data-comment-id="c1">see</span></p>', collab: 0 }

    const kinds = [yjs, overlap, html].map((legacy) => convertLegacy(legacy, MAX_STATE).kind)

    expect(kinds).toEqual(['converted', 'converted', 'converted'])
  })
})
