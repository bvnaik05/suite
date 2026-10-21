import { describe, expect, it } from 'vitest'
import { Doc, XmlElement, XmlText } from 'yjs'

import { domInventory, inventory, rawStyles, unkept } from '@/apps/writer/collab/inventory'

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

function mentionName(node: Element) {
  return node.matches('span[data-type=mention]') ? 'mention' : undefined
}

function htmlInventory(html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return domInventory(parsed.body, mentionName)
}

function unkeptHtml(source: string, result: string) {
  return unkept(htmlInventory(source), htmlInventory(result))
}

describe('what drawn HTML keeps of the old HTML', () => {
  it('ignores a span with nothing on it', () => {
    expect(unkeptHtml('<p><span>hi</span></p>', '<p>hi</p>')).toEqual([])
  })

  it('needs every class drawn, letting the drawn HTML add its own', () => {
    expect(unkeptHtml('<p class="a">hi</p>', '<p class="b a">hi</p>')).toEqual([])
    expect(unkeptHtml('<p class="a b">hi</p>', '<p class="a">hi</p>')).toEqual(['element p'])
    expect(unkeptHtml('<p><span class="a">hi</span></p>', '<p>hi</p>')).toEqual(['formatting at 0'])
  })

  it('leaves out the noise attributes', () => {
    expect(
      unkeptHtml('<p spellcheck="false">x <img loading="lazy"></p>', '<p>x <img></p>'),
    ).toEqual([])
  })

  it('compares a style property by property', () => {
    const both = '<p style="text-align: center; line-height: 2">x</p>'

    expect(unkeptHtml(both, '<p style="line-height: 2; text-align: center">x</p>')).toEqual([])
    expect(unkeptHtml(both, '<p style="text-align: right; line-height: 2">x</p>')).toEqual([
      'element p',
    ])
  })

  it('compares a style property with its priority', () => {
    const important = '<p style="text-align: center !important">x</p>'

    expect(unkeptHtml(important, important)).toEqual([])
    expect(unkeptHtml(important, '<p style="text-align: center">x</p>')).toEqual(['element p'])
    expect(
      unkeptHtml(
        '<span style="color: red !important">x</span>',
        '<span style="color: red">x</span>',
      ),
    ).toEqual(['formatting at 0'])
  })

  it('compares a colour by its being there, inherit counting as none', () => {
    const palette = '<span style="color: var(--prose-color-red)">x</span>'

    expect(unkeptHtml('<span style="color: #dc2626">x</span>', palette)).toEqual([])
    expect(unkeptHtml('<span style="color: inherit">x</span>', 'x')).toEqual([])
    expect(unkeptHtml('<span style="color: #dc2626">x</span>', 'x')).toEqual(['formatting at 0'])
  })

  it('reads an atom by its name, attributes and the words it holds', () => {
    const source = '<p>hi <span data-type="mention" data-id="u1">@Ann</span></p>'

    expect(
      unkeptHtml(source, '<p>hi <span data-type="mention" data-id="u1">Ann</span></p>'),
    ).toEqual(['text at 2'])
    expect(
      unkeptHtml(source, '<p>hi <span data-type="mention" data-id="u2">@Ann</span></p>'),
    ).toEqual(['element mention'])
  })

  it('leaves out the whitespace the parser folds', () => {
    expect(unkeptHtml('<p>a b\n\tc</p>', '<p>abc</p>')).toEqual([])
  })

  it('counts a non-breaking space and a line break', () => {
    expect(unkeptHtml('<p>a\u00a0b</p>', '<p>a b</p>')).toEqual(['text at 1'])
    expect(unkeptHtml('<p>a<br>b</p>', '<p>a b</p>')).toEqual(['element br'])
  })
})

function rawOf(html: string) {
  return rawStyles(new DOMParser().parseFromString(html, 'text/html').body)
}

describe('what the parse keeps of the raw style text', () => {
  it('keeps a shorthand the parse splits into longhands, and skips empty pieces', () => {
    expect(rawOf('<p style="border: 1px solid red; margin: 0 auto; ;">x</p>')).toEqual({
      isKept: true,
      noise: [],
    })
  })

  it.each([
    { name: 'an unknown property', style: 'foo-bar: 1' },
    { name: 'a value the parse rejects', style: 'color: notacolour' },
    { name: 'a property in capitals', style: 'COLOR: red' },
    { name: 'a piece with no colon', style: 'color red' },
    { name: 'a lost !important', style: 'color: notacolour !important; color: red' },
  ])('loses $name', ({ style }) => {
    expect(rawOf(`<p><span style="${style}">x</span></p>`).isKept).toBe(false)
  })

  it("reads past Word's own properties, naming each once", () => {
    const word = 'mso-spacerun: yes; mso-ansi-language: EN'

    expect(rawOf(`<p style="mso-spacerun: yes"><span style="${word}">x</span></p>`)).toEqual({
      isKept: true,
      noise: ['mso-spacerun', 'mso-ansi-language'],
    })
  })
})
