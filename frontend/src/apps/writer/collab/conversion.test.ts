import { Editor, generateJSON, getSchema } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
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
import { placeThread } from '@/apps/writer/collab/places'
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
// Drive's ink as it saved it on text left at its default
const INK = 'style="color: rgb(31, 39, 46)"'

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

function yRuns(...pieces: [string, Record<string, unknown>?][]) {
  const content = new XmlText()
  let at = 0
  for (const [piece, attributes] of pieces) {
    content.insert(at, piece, attributes ?? {})
    at += piece.length
  }

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

function yAtom(name: string, attributes: Record<string, string>) {
  const node = new XmlElement(name)
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value)
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

// The converted state open in an editor, the way a tab opens it
function openConverted(state: Uint8Array) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...writerSchema(), Collaboration.configure({ document: opened(state) })],
  })
  editors.push(editor)
  return editor
}

// Where the editor shows a thread and the words there
function shown(editor: Editor, anchor: string) {
  const place = placeThread(editor.state, anchor)
  if (place.kind !== 'text') {
    return place.kind
  }

  return {
    from: place.from,
    to: place.to,
    text: editor.state.doc.textBetween(place.from, place.to),
  }
}

// Each stored run of a paragraph's text with the keys it holds
function storedRuns(state: Uint8Array, index: number) {
  const block = opened(state).getXmlFragment(BODY_FIELD).get(index) as XmlElement
  const runs: { insert: string; attributes?: object }[] = (block.get(0) as XmlText).toDelta()
  return runs.map(({ insert, attributes }) => [insert, Object.keys(attributes ?? {})])
}

function paragraph(...content: object[]) {
  return { type: 'paragraph', content }
}

function words(text: string) {
  return paragraph({ type: 'text', text })
}

// Each run's text with the colours drawn on it
function drawnColours(
  content: { text: string; marks?: { type: string; attrs: Record<string, unknown> }[] }[],
) {
  return content.map(({ text, marks = [] }) => [
    text,
    marks.filter(({ attrs }) => attrs.color != null).map(({ type, attrs }) => [type, attrs.color]),
  ])
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

  it("keeps Drive's top-level block image in a paragraph with all it stored (R332)", () => {
    const attrs = { src: SRC, uploadId: 'u1', alt: 'Sales chart', title: 'Q3' }
    const doc = legacyDoc(yParagraph('one'), yAtom('image', attrs))

    const result = convert(stored(doc))

    const image = { type: 'image', attrs: { ...attrs, align: 'left' } }
    const body = page(words('one'), paragraph(image))
    expect([bodyOf(result.state), result.dropped]).toEqual([body, []])
  })

  it("keeps Drive's block image after a list item's paragraph, in a paragraph there", () => {
    const item = yElement('listItem', yParagraph('item'), yAtom('image', { src: SRC }))

    const result = convert(stored(legacyDoc(yElement('bulletList', item))))

    const image = { type: 'image', attrs: { src: SRC, align: 'left' } }
    const list = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [words('item'), paragraph(image)] }],
    }
    expect([bodyOf(result.state), result.dropped]).toEqual([page(list), []])
  })

  it('keeps a top-level video as a block', () => {
    const doc = legacyDoc(yParagraph('one'), yAtom('video', { src: '/files/demo.mp4' }))

    const result = convert(stored(doc))

    const video = { type: 'video', attrs: { src: '/files/demo.mp4' } }
    expect([bodyOf(result.state), result.dropped]).toEqual([page(words('one'), video), []])
  })

  it("drops Drive's table of contents with its stored hint and records it (R341)", () => {
    const toc = yAtom('tocNode', { placeholder: 'Table of Contents' })
    const doc = legacyDoc(yParagraph('one'), toc, yParagraph('two'))

    const result = convert(stored(doc))

    expect(bodyOf(result.state)).toEqual(page(words('one'), words('two')))
    expect(result.dropped).toEqual([{ kind: 'node', name: 'tocNode', text: '' }])
  })

  it.each([
    {
      name: 'another attribute',
      toc: () => yAtom('tocNode', { placeholder: 'Table of Contents', title: 'x' }),
    },
    {
      name: 'text',
      toc: () => {
        const toc = yElement('tocNode', new XmlText('Intro'))
        toc.setAttribute('placeholder', 'Table of Contents')
        return toc
      },
    },
    {
      name: 'a horizontal rule',
      toc: () => {
        const toc = yElement('tocNode', new XmlElement('horizontalRule'))
        toc.setAttribute('placeholder', 'Table of Contents')
        return toc
      },
    },
    {
      name: 'a paragraph with an attribute',
      toc: () => {
        const toc = yElement('tocNode', yAtom('paragraph', { textAlign: 'center' }))
        toc.setAttribute('placeholder', 'Table of Contents')
        return toc
      },
    },
  ])("refuses Drive's table of contents holding $name besides its hint (R346)", ({ toc }) => {
    const legacy = stored(legacyDoc(yParagraph('one'), toc(), yParagraph('two')))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('converts a body holding an empty list, which the editor hides', () => {
    const doc = legacyDoc(yParagraph('one'), new XmlElement('bulletList'))

    const result = convert(stored(doc))

    expect([bodyOf(result.state), result.dropped]).toEqual([page(words('one')), []])
  })

  it('refuses a part the editor cannot hold that holds text (R316)', () => {
    const legacy = stored(legacyDoc(yParagraph('one'), yElement('callout', yParagraph('note'))))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it.each([
    { name: 'in a paragraph', inside: () => yElement('paragraph', yAtom('image', { src: SRC })) },
    { name: 'directly', inside: () => yAtom('image', { src: SRC }) },
  ])('refuses a part the editor cannot hold that has an image in it $name (R316)', ({ inside }) => {
    const legacy = stored(legacyDoc(yParagraph('one'), yElement('callout', inside())))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it.each([
    {
      name: 'a list',
      outer: () =>
        yElement(
          'bulletList',
          yElement('listItem', yParagraph('item')),
          yAtom('image', { src: SRC }),
        ),
    },
    {
      name: 'a table row',
      outer: () => yElement('table', yElement('tableRow', yAtom('image', { src: SRC }))),
    },
  ])(
    'refuses a block image directly in $name, where no paragraph can hold it (R344)',
    ({ outer }) => {
      const legacy = stored(legacyDoc(yParagraph('one'), outer()))

      expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
    },
  )

  it('refuses a part the editor cannot hold that stores an attribute', () => {
    const legacy = stored(legacyDoc(yParagraph('one'), yAtom('callout', { kind: 'note' })))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
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
    expect(result.dropped).toEqual([{ kind: 'pending', text: ' second', parts: [] }])
  })

  it('records a held-back change that adds a part and no text', () => {
    const writer = legacyDoc(yParagraph('first'))
    const before = encodeStateVector(writer)
    writer.getXmlFragment(BODY_FIELD).insert(1, [new XmlElement('pageBreak')])
    const later = encodeStateAsUpdate(writer, before)
    const other = legacyDoc(yParagraph('kept'))
    const content = toBase64(mergeUpdates([encodeStateAsUpdate(other), later]))

    const result = convert({ content, html: '', collab: 1 })

    expect(result.dropped).toEqual([{ kind: 'pending', text: '', parts: ['pageBreak'] }])
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

  it('keeps a mention saved in the HTML, its words matching its label', () => {
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
    { name: 'video', html: '<video controls><source src="/v.mp4"></video>' },
    { name: 'attachment', html: '<p><a data-attachment href="/f">Quarterly report.pdf</a></p>' },
    {
      name: 'mention',
      html:
        '<p><span class="mention" data-type="mention" data-id="x" data-label="Ann">' +
        '@Ann and Bob</span></p>',
    },
    { name: 'video fallback', html: `<video src="/v.mp4">Can't play</video>` },
  ])("refuses HTML whose $name holds what the editor wouldn't draw", ({ html }) => {
    const legacy = { content: null, html, collab: 0 }

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('keeps a Drive video whose source repeats its src', () => {
    const html = '<video src="/v.mp4" controls><source src="/v.mp4" type="video/mp4"></video>'

    const result = convert({ content: null, html, collab: 0 })

    const media = bodyOf(result.state).content.map(({ type, attrs }) => [type, attrs.src])
    expect(media).toEqual([['video', '/v.mp4']])
  })

  it('keeps an attachment saved in the HTML with its name', () => {
    const html = '<p><a data-attachment href="/f.pdf" data-file-name="r.pdf">r.pdf</a></p>'

    const result = convert({ content: null, html, collab: 0 })

    const attachment = { type: 'attachment', attrs: { src: '/f.pdf', fileName: 'r.pdf' } }
    expect(bodyOf(result.state)).toEqual(page(paragraph(attachment)))
  })

  it('refuses HTML holding a table of contents, which the editor has no node for', () => {
    const toc = '<div data-type="toc-node"><ol><li>Intro</li></ol></div>'
    const legacy = { content: null, html: `${toc}<h2>Intro</h2>`, collab: 0 }

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
    { name: 'a comment with a blank id', mark: { comment: { commentId: ' ' } } },
    { name: 'a comment with a number for its id', mark: { comment: { commentId: 7 } } },
    {
      name: 'a hashed copy of a comment with no id',
      mark: { 'comment--a+/=bC9z': { commentId: null } },
    },
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

  it('refuses a comment beside an annotation, which no thread is made from yet', () => {
    const comment = { comment: { commentId: 'c1' } }
    const annotation = { annotation: { annotationID: 'a1' } }
    const legacy = stored(legacyDoc(yRuns(['one', comment], [' '], ['two', annotation])))

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

  it('converts comments that carry their thread ids, in Yjs, as a lone overlapping copy read by its mark name and in HTML', () => {
    const yjs = stored(legacyDoc(yMarked('see', { comment: { commentId: 'c1' } })))
    const overlap = stored(legacyDoc(yMarked('see', { 'comment--a+/=bC9z': { commentId: 'c2' } })))
    const html = { content: null, html: '<p><span data-comment-id="c1">see</span></p>', collab: 0 }

    const results = [yjs, overlap, html].map(convert)

    // The lone copy is drawn as a comment, so the converted body holds it under the plain key
    expect(results.map(({ anchors }) => Object.keys(anchors))).toEqual([['c1'], ['c2'], ['c1']])
  })

  it('refuses two comments on the same words, the second one having no anchor', () => {
    const both = { comment: { commentId: 'c1' }, 'comment--a+/=bC9z': { commentId: 'c2' } }
    const legacy = stored(legacyDoc(yMarked('see', both)))

    // Only the plain comment key moves onto an anchor; the hashed copy stays behind, so the body
    // no longer matches itself without comment marks
    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('anchors an old comment on its words and leaves no comment mark', () => {
    const marks = { comment: { commentId: 'c1' }, bold: {} }
    const doc = legacyDoc(yRuns(['one '], ['two', marks], [' three']))

    const result = convert(stored(doc))

    expect(shown(openConverted(result.state), result.anchors.c1)).toEqual({
      from: 5,
      to: 8,
      text: 'two',
    })
    const bold = { type: 'text', text: 'two', marks: [{ type: 'bold' }] }
    const body = paragraph({ type: 'text', text: 'one ' }, bold, { type: 'text', text: ' three' })
    expect(bodyOf(result.state)).toEqual(page(body))
    expect(storedRuns(result.state, 0)).toEqual([
      ['one ', []],
      ['two', ['bold']],
      [' three', []],
    ])
  })

  it('anchors an old comment saved in the HTML on its words', () => {
    const html = '<p>one <span data-comment-id="c1">two</span> three</p>'

    const result = convert({ content: null, html, collab: 0 })

    expect(shown(openConverted(result.state), result.anchors.c1)).toEqual({
      from: 5,
      to: 8,
      text: 'two',
    })
    expect(bodyOf(result.state)).toEqual(page(words('one two three')))
  })

  it('anchors an old comment on a mention and takes the mark off the mention', () => {
    const mention = yAtom('mention', { id: 'x', label: 'Ann' })
    mention.setAttribute('comment', { commentId: 'c1' } as never)
    const doc = legacyDoc(yElement('paragraph', new XmlText('hi '), mention))

    const result = convert(stored(doc))

    expect(placeThread(openConverted(result.state).state, result.anchors.c1)).toEqual({
      kind: 'text',
      from: 4,
      to: 5,
      quote: '@Ann',
    })
    const shownMention = { type: 'mention', attrs: { id: 'x', label: 'Ann' } }
    const body = paragraph({ type: 'text', text: 'hi ' }, shownMention)
    expect(bodyOf(result.state)).toEqual(page(body))
    const block = opened(result.state).getXmlFragment(BODY_FIELD).get(0) as XmlElement
    const attributes = (block.get(1) as XmlElement).getAttributes()
    expect([Object.hasOwn(attributes, 'comment'), attributes.id, attributes.label]).toEqual([
      false,
      'x',
      'Ann',
    ])
  })

  it('records a far copy of a comment and keeps its words with their other marks', () => {
    const doc = legacyDoc(
      yRuns(['one '], ['two', { comment: { commentId: 'c1' } }]),
      yParagraph('filler'),
      yRuns(['copy', { comment: { commentId: 'c1' }, italic: {} }]),
    )

    const result = convert(stored(doc))

    expect(shown(openConverted(result.state), result.anchors.c1)).toEqual({
      from: 5,
      to: 8,
      text: 'two',
    })
    expect(result.dropped).toEqual([{ kind: 'comment-copy', id: 'c1', text: 'copy' }])
    const italic = paragraph({ type: 'text', text: 'copy', marks: [{ type: 'italic' }] })
    expect(bodyOf(result.state)).toEqual(page(words('one two'), words('filler'), italic))
    expect(storedRuns(result.state, 2)).toEqual([['copy', ['italic']]])
  })

  it("keeps typing at a converted comment's edges outside it (R324)", () => {
    const doc = legacyDoc(yRuns(['one '], ['two', { comment: { commentId: 'c1' } }], [' three']))
    const result = convert(stored(doc))
    const editor = openConverted(result.state)

    editor.commands.insertContentAt(8, 'X')
    editor.commands.insertContentAt(5, 'X')

    expect([shown(editor, result.anchors.c1), editor.getText()]).toEqual([
      { from: 6, to: 9, text: 'two' },
      'one XtwoX three',
    ])
  })

  it('gives no anchors to a body with no comments', () => {
    expect(convert(stored(legacyDoc(yParagraph('one')))).anchors).toEqual({})
  })

  it('anchors a comment in three places far apart on the first, recording both copies', () => {
    const comment = { comment: { commentId: 'c1' } }
    const doc = legacyDoc(
      yRuns(['one '], ['two', comment]),
      yParagraph('filler'),
      yRuns(['copy', comment]),
      yParagraph('filler'),
      yRuns(['again', comment]),
    )

    const result = convert(stored(doc))

    expect(shown(openConverted(result.state), result.anchors.c1)).toEqual({
      from: 5,
      to: 8,
      text: 'two',
    })
    expect(result.dropped).toEqual([
      { kind: 'comment-copy', id: 'c1', text: 'copy' },
      { kind: 'comment-copy', id: 'c1', text: 'again' },
    ])
  })

  it.each([
    {
      name: 'Yjs',
      legacy: stored(legacyDoc(yMarked('see', { comment: { commentId: '__proto__' } }))),
    },
    {
      name: 'HTML',
      legacy: {
        content: null,
        html: '<p><span data-comment-id="__proto__">see</span></p>',
        collab: 0,
      },
    },
  ])('refuses a comment whose id names the prototype, from $name', ({ legacy }) => {
    // Its anchor can't be kept under that key, so the comment would lose its thread
    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('refuses a Yjs body whose link holds an attribute the link mark lacks', () => {
    const legacy = stored(legacyDoc(yMarked('go', { link: { href: '/a', tracking: 'x1' } })))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('refuses a Yjs body whose paragraph holds an attribute paragraphs lack', () => {
    const block = yParagraph('one')
    block.setAttribute('align', 'mid')

    expect(convertLegacy(stored(legacyDoc(block)), MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it("converts Drive's blocks that hold its default indent and heading line height (R331)", () => {
    const block = yParagraph('one')
    block.setAttribute('indent', 0 as never)
    block.setAttribute('lineHeight', '100%')
    const heading = yHeading('Two')
    heading.setAttribute('indent', '0')
    heading.setAttribute('lineHeight', '100%')

    const result = convert(stored(legacyDoc(block, heading)))

    const blocks = bodyOf(result.state).content.map((converted) => [
      converted.type,
      converted.attrs.lineHeight ?? null,
      converted.content[0].text,
    ])
    expect(blocks).toEqual([
      ['paragraph', '100%', 'one'],
      ['heading', null, 'Two'],
    ])
  })

  it("refuses a block indented past Drive's default", () => {
    const block = yParagraph('one')
    block.setAttribute('indent', 1 as never)

    expect(convertLegacy(stored(legacyDoc(block)), MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it("refuses a heading whose line height isn't Drive's default", () => {
    const heading = yHeading('Two')
    heading.setAttribute('lineHeight', '150%')

    expect(convertLegacy(stored(legacyDoc(heading)), MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it("converts Drive's HTML blocks that hold its default indent (R331)", () => {
    const indent = 'style="margin-left: 0px!important;"'
    const html = `<p ${indent}>one</p><h2 ${indent}>Two</h2>`

    const result = convert({ content: null, html, collab: 0 })

    const blocks = bodyOf(result.state).content.map((block) => [block.type, block.content[0].text])
    expect(blocks).toEqual([
      ['paragraph', 'one'],
      ['heading', 'Two'],
    ])
  })

  it.each([
    { name: "indented past Drive's default", html: '<p style="margin-left: 24px">one</p>' },
    {
      name: "with a heading line height the editor can't hold",
      html: '<h1 style="line-height: 150%">Two</h1>',
    },
    { name: 'holding formatting the editor has no mark for', html: '<p>x<sup>2</sup></p>' },
    { name: 'with a block attribute the editor drops', html: '<p dir="rtl">one</p>' },
    {
      name: "with a colour the editor can't read",
      html: '<p><span style="color: hsl(0, 70%, 50%)">red</span></p>',
    },
  ])('refuses HTML $name', ({ html }) => {
    const legacy = { content: null, html, collab: 0 }

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it("keeps Drive's HTML text colour and highlight as palette colours, and its ink as none", () => {
    const highlight = 'data-color="#fef9c3" style="background-color: #fef9c3; color: inherit"'
    const html = [
      '<p><span style="color: #dc2626">red</span>',
      `<mark ${highlight}>lit</mark>`,
      '<span style="color: #1F272E">ink</span></p>',
    ].join('')

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['red', [['textStyle', 'red']]],
      ['lit', [['namedHighlight', 'yellow']]],
      ['ink', []],
    ])
  })

  it("refuses Drive's ink inside a coloured span, which would draw in that colour", () => {
    const html = `<p><span style="color: #dc2626">a<span ${INK}>b</span></span></p>`

    expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it("drops Drive's ink inside its ink", () => {
    const html = `<p><span ${INK}>a<span ${INK}>b</span></span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['ab', []]])
  })

  it("drops Drive's ink inside a highlight", () => {
    const html = `<p><mark style="background-color: #fef08a">a<span ${INK}>b</span></mark></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    const yellow = [['namedHighlight', 'yellow']]
    expect(drawnColours(content)).toEqual([
      ['a', yellow],
      ['b', yellow],
    ])
  })

  it('keeps an HTML link, which gains a target and rel', () => {
    const result = convert({ content: null, html: '<p><a href="/a">go</a></p>', collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(content[0].marks[0].attrs.href).toBe('/a')
  })

  it('keeps a Yjs link, which gains the link mark defaults', () => {
    const result = convert(stored(legacyDoc(yMarked('go', { link: { href: '/a' } }))))

    const [{ content }] = bodyOf(result.state).content
    expect(content[0].marks[0].attrs.href).toBe('/a')
  })

  it('keeps a table whose cell holds its widths and a span at its default', () => {
    const cell = yElement('tableCell', yParagraph('x'))
    cell.setAttribute('colwidth', [100] as never)
    cell.setAttribute('colspan', 1 as never)
    const doc = legacyDoc(yElement('table', yElement('tableRow', cell)))

    const result = convert(stored(doc))

    const [table] = bodyOf(result.state).content
    expect(table.content[0].content[0].attrs).toMatchObject({ colwidth: [100], colspan: 1 })
  })

  it('refuses when converting the old media moves where an image points', () => {
    vi.mocked(convertOldMedia).mockImplementationOnce((body) => {
      const image = new XmlElement('image')
      image.setAttribute('src', '/files/other.png')
      body.delete(0, 1)
      body.insert(0, [yElement('paragraph', image)])
    })
    const legacy = stored(legacyDoc(oldMedia({ src: SRC, 'media-type': 'img' })))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })
})
