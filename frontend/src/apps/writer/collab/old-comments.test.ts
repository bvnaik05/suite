import { getSchema } from '@tiptap/core'
import { initProseMirrorDoc, relativePositionToAbsolutePosition } from '@tiptap/y-tiptap'
import { describe, expect, it } from 'vitest'
import {
  applyUpdate,
  createAbsolutePositionFromRelativePosition,
  Doc,
  encodeStateAsUpdate,
  XmlElement,
  XmlText,
  type RelativePosition,
} from 'yjs'

import { readAnchor } from '@/apps/writer/collab/anchors'
import { BODY_FIELD } from '@/apps/writer/collab/field'
import { oldCommentAnchors } from '@/apps/writer/collab/old-comments'
import { writerSchema } from '@/apps/writer/schema'

const schema = getSchema(writerSchema())

type Piece = [string, Record<string, unknown>?]

function comment(id: string) {
  return { comment: { commentId: id } }
}

function yParagraph(...pieces: Piece[]) {
  const text = new XmlText()
  let at = 0
  for (const [piece, attributes] of pieces) {
    text.insert(at, piece, attributes ?? {})
    at += piece.length
  }

  const node = new XmlElement('paragraph')
  node.insert(0, [text])
  return node
}

function yMention(commentId: string) {
  const mention = new XmlElement<Record<string, object | string>>('mention')
  mention.setAttribute('id', 'x')
  mention.setAttribute('label', 'Ann')
  mention.setAttribute('comment', comment(commentId).comment)
  return mention
}

function yText(content: string, commentId: string) {
  const text = new XmlText()
  text.insert(0, content, comment(commentId))
  return text
}

function yInline(...children: (XmlText | XmlElement<Record<string, object | string>>)[]) {
  const node = new XmlElement('paragraph')
  node.insert(0, children)
  return node
}

function docWith(...blocks: XmlElement[]) {
  const doc = new Doc()
  doc.getXmlFragment(BODY_FIELD).insert(0, blocks)
  return doc
}

function words(text: XmlText) {
  return text
    .toDelta()
    .map(({ insert }: { insert: string }) => insert)
    .join('')
}

// The text an end sits in and its index there
function placeOf(doc: Doc, position: RelativePosition) {
  const absolute = createAbsolutePositionFromRelativePosition(position, doc)!
  return [words(absolute.type as XmlText), absolute.index]
}

function textAnchor(anchor: string) {
  const read = readAnchor(anchor)
  if (read.kind !== 'text') {
    throw new Error(`not a text anchor: ${anchor}`)
  }

  return read
}

function placed(doc: Doc, anchor: string) {
  const read = textAnchor(anchor)
  return { start: placeOf(doc, read.start), end: placeOf(doc, read.end), quote: read.quote }
}

// Where the anchor's ends fall in the editor's document
function editorRange(doc: Doc, anchor: string) {
  const { start, end, quote } = textAnchor(anchor)
  const body = doc.getXmlFragment(BODY_FIELD)
  const { mapping } = initProseMirrorDoc(body, schema)
  const from = relativePositionToAbsolutePosition(doc, body, start, mapping, new Set())
  const to = relativePositionToAbsolutePosition(doc, body, end, mapping, new Set())
  return { from, to, quote }
}

describe('oldCommentAnchors', () => {
  it('anchors a comment on the words its mark covers', () => {
    const doc = docWith(yParagraph(['say '], ['hello', comment('c1')], [' world']))

    const anchors = oldCommentAnchors(doc.getXmlFragment(BODY_FIELD), schema)

    expect(Object.keys(anchors)).toEqual(['c1'])
    const text = 'say hello world'
    expect(placed(doc, anchors.c1)).toEqual({ start: [text, 4], end: [text, 9], quote: 'hello' })
  })

  it('anchors a comment running across two paragraphs from its first word to its last', () => {
    const doc = docWith(
      yParagraph(['end of '], ['one', comment('c2')]),
      yParagraph(['start', comment('c2')], [' of two']),
    )

    const anchors = oldCommentAnchors(doc.getXmlFragment(BODY_FIELD), schema)

    expect(placed(doc, anchors.c2)).toEqual({
      start: ['end of one', 7],
      end: ['start of two', 5],
      quote: 'one start',
    })
  })

  it('spans the unmarked words inside one comment, so the comment keeps one place', () => {
    const doc = docWith(yParagraph(['ab', comment('c3')], ['XY'], ['cd', comment('c3')]))

    const anchors = oldCommentAnchors(doc.getXmlFragment(BODY_FIELD), schema)

    expect(placed(doc, anchors.c3)).toEqual({
      start: ['abXYcd', 0],
      end: ['abXYcd', 6],
      quote: 'abXYcd',
    })
  })

  it('anchors two comments on overlapping words, each under its own mark name', () => {
    const first = { 'comment--a+/=bC9z': { commentId: 'k1' } }
    const second = { 'comment--Zx9/+=Qw': { commentId: 'k2' } }
    const doc = docWith(yParagraph(['ove', first], ['rl', { ...first, ...second }], ['ap', second]))

    const anchors = oldCommentAnchors(doc.getXmlFragment(BODY_FIELD), schema)

    const text = 'overlap'
    expect(placed(doc, anchors.k1)).toEqual({ start: [text, 0], end: [text, 5], quote: 'overl' })
    expect(placed(doc, anchors.k2)).toEqual({ start: [text, 3], end: [text, 7], quote: 'rlap' })
  })

  // The quote follows anchorSelection, which reads a mention as no text
  it('quotes a comment holding a mention as the editor quotes it', () => {
    const doc = docWith(yInline(yText('hi ', 'c1'), yMention('c1'), yText(' there', 'c1')))

    const anchors = oldCommentAnchors(doc.getXmlFragment(BODY_FIELD), schema)

    expect(placed(doc, anchors.c1)).toEqual({
      start: ['hi ', 0],
      end: [' there', 6],
      quote: 'hi  there',
    })
  })

  it('anchors a comment made on a mention alone on that mention', () => {
    const doc = docWith(yInline(yMention('c1')))

    const anchors = oldCommentAnchors(doc.getXmlFragment(BODY_FIELD), schema)

    expect(editorRange(doc, anchors.c1)).toEqual({ from: 1, to: 2, quote: '' })
  })

  it('ends a comment closing on a mention just after the mention', () => {
    const doc = docWith(yInline(yText('hi ', 'c1'), yMention('c1')))

    const anchors = oldCommentAnchors(doc.getXmlFragment(BODY_FIELD), schema)

    expect(editorRange(doc, anchors.c1)).toEqual({ from: 1, to: 5, quote: 'hi ' })
  })

  it('gives no anchor when no text carries a comment', () => {
    const doc = docWith(yParagraph(['plain', { bold: true }]))

    expect(oldCommentAnchors(doc.getXmlFragment(BODY_FIELD), schema)).toEqual({})
  })

  it('keeps a long comment within the stored anchor limit, quoting its start', () => {
    const long = 'a'.repeat(400)
    const doc = docWith(yParagraph([long, comment('c4')]))

    const anchors = oldCommentAnchors(doc.getXmlFragment(BODY_FIELD), schema)

    expect([...anchors.c4].length).toBeLessThanOrEqual(255)
    const { start, end, quote } = placed(doc, anchors.c4)
    expect([start, end]).toEqual([
      [long, 0],
      [long, 400],
    ])
    expect(quote.length).toBeGreaterThan(0)
    expect(long.startsWith(quote)).toBe(true)
  })

  it('anchors on the stored items, so a copy of the saved state finds the same words', () => {
    const doc = docWith(yParagraph(['say '], ['hello', comment('c1')]))
    const anchors = oldCommentAnchors(doc.getXmlFragment(BODY_FIELD), schema)

    const copy = new Doc()
    applyUpdate(copy, encodeStateAsUpdate(doc))

    expect(placed(copy, anchors.c1)).toEqual({
      start: ['say hello', 4],
      end: ['say hello', 9],
      quote: 'hello',
    })
  })
})
