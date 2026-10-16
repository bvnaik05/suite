import { describe, expect, it } from 'vitest'
import { Doc, XmlElement, XmlText } from 'yjs'

import { inventory, unkept } from '@/apps/writer/collab/inventory'

type Run = [string, Record<string, unknown>?]

type Child = XmlElement | XmlText

function element(name: string, attributes: Record<string, unknown>, ...children: Child[]) {
  const node = new XmlElement(name)
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value as string)
  }

  node.insert(0, children)
  return node
}

function text(...runs: Run[]) {
  const content = new XmlText()
  let at = 0
  for (const [words, attributes] of runs) {
    content.insert(at, words, attributes ?? {})
    at += words.length
  }

  return content
}

function paragraph(...runs: Run[]) {
  return element('paragraph', {}, text(...runs))
}

function body(...blocks: Child[]) {
  const fragment = new Doc().getXmlFragment('default')
  fragment.insert(0, blocks)
  return fragment
}

function unkeptBetween(source: Child[], result: Child[]) {
  return unkept(inventory(body(...source)), inventory(body(...result)))
}

function sample() {
  return [paragraph(['say '], ['hi', { bold: {} }]), element('pageBreak', {})]
}

function highlighted(color: string) {
  return [paragraph(['ab', { highlight: { color } }])]
}

function linked(attrs: object) {
  return [paragraph(['go', { link: attrs }])]
}

function cell(colwidth: number[]) {
  return element('tableCell', { colwidth }, paragraph(['x']))
}

function mention(label: string) {
  return element('mention', { id: 'u1', label })
}

function image(src: string) {
  return element('image', { src })
}

describe('what a result keeps of its source', () => {
  it('keeps all of a body holding the same text, formatting and elements', () => {
    expect(unkeptBetween(sample(), sample())).toEqual([])
  })

  it('misses text that changed order or was cut short', () => {
    expect(unkeptBetween([paragraph(['ab'])], [paragraph(['ba'])])).toEqual(['text at 0'])
    expect(unkeptBetween([paragraph(['abc'])], [paragraph(['ab'])])).toEqual(['text at 2'])
  })

  it('misses a mark that is gone or whose value changed', () => {
    expect(unkeptBetween([paragraph(['ab', { bold: {} }])], [paragraph(['ab'])])).toEqual([
      'formatting at 0',
    ])
    expect(unkeptBetween(highlighted('red'), highlighted('blue'))).toEqual(['formatting at 0'])
  })

  it('reads an overlapping copy of a mark by the mark name', () => {
    const source = [paragraph(['see', { 'comment--a+/=bC9z': { commentId: 'c1' } }])]
    const result = [paragraph(['see', { comment: { commentId: 'c1' } }])]

    expect(unkeptBetween(source, result)).toEqual([])
  })

  it('misses one of two copies of a mark when the result holds one', () => {
    const result = { comment: { commentId: 'c1' } }
    for (const other of ['c1', 'c2']) {
      const source = [paragraph(['see', { ...result, 'comment--a+/=bC9z': { commentId: other } }])]

      expect(unkeptBetween(source, [paragraph(['see', result])])).toEqual(['formatting at 0'])
    }
  })

  it('keeps a value that gained defaults, and misses one whose own key changed', () => {
    const blank = { href: '/a', target: '_blank' }

    expect(unkeptBetween(linked({ href: '/a' }), linked(blank))).toEqual([])
    expect(unkeptBetween(linked({ href: '/a', target: '_self' }), linked(blank))).toEqual([
      'formatting at 0',
    ])
  })

  it('compares a list value item by item, in order', () => {
    expect(unkeptBetween([cell([100, 80])], [cell([100, 80])])).toEqual([])
    expect(unkeptBetween([cell([100, 80])], [cell([80, 100])])).toEqual(['element tableCell'])
  })

  it('misses an attribute the result left off an element', () => {
    const source = [element('paragraph', { lineHeight: '2', align: 'mid' }, text(['x']))]
    const result = [element('paragraph', { lineHeight: '2' }, text(['x']))]

    expect(unkeptBetween(source, result)).toEqual(['element paragraph'])
  })

  it('misses an atom whose attribute changed', () => {
    expect(unkeptBetween([mention('Ann')], [mention('Bob')])).toEqual(['element mention'])
  })

  it('misses elements that changed order, and keeps extras the result added', () => {
    expect(unkeptBetween([image('/a'), image('/b')], [image('/b'), image('/a')])).toEqual([
      'element image',
    ])
    expect(unkeptBetween([image('/a')], [paragraph(), image('/a'), paragraph()])).toEqual([])
  })

  it('misses an embed in the text, which no result holds', () => {
    const content = text(['ab'])
    content.insertEmbed(1, { kind: 'old' })

    expect(unkeptBetween([element('paragraph', {}, content)], [paragraph(['ab'])])).toEqual([
      'element #embed',
    ])
  })

  it('leaves out what is skipped and all it holds, and attributes set to null', () => {
    const lost = element('callout', {}, paragraph(['note']))
    const source = body(paragraph(['one']), lost, element('paragraph', { lineHeight: null }))

    const found = inventory(source, new Set([lost]))

    expect(unkept(found, inventory(body(paragraph(['one']), paragraph())))).toEqual([])
  })
})
