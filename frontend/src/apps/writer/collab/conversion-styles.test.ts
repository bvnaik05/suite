import type { JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { XmlText } from 'yjs'

import { convertLegacy } from '@/apps/writer/collab/conversion'
import {
  bodyOf,
  convert,
  drawnColours,
  INK,
  legacyDoc,
  MAX_STATE,
  openConverted,
  SRC,
  stored,
  yAtom,
  yElement,
  yHeading,
  yMarked,
  yParagraph,
} from '@/apps/writer/collab/legacy-fixtures'

// Each block's tag, left margin with its priority, and line height, as the editor draws them
function blockLayout(state: Uint8Array) {
  return [...openConverted(state).view.dom.children].map((element) => {
    const { style } = element as HTMLElement
    const margin = style.getPropertyValue('margin-left')
    return [element.localName, margin, style.getPropertyPriority('margin-left'), style.lineHeight]
  })
}

// Each block's alignment, as stored and as the editor draws it
function alignments(state: Uint8Array) {
  const held = bodyOf(state).content.map((block: JSONContent) => block.attrs?.textAlign)
  const drawn = [...openConverted(state).view.dom.children].map(
    (element) => (element as HTMLElement).style.textAlign,
  )
  return { stored: held, drawn }
}

describe('convertLegacy', () => {
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
    heading.setAttribute('indent', 0 as never)
    heading.setAttribute('lineHeight', '100%')

    const result = convert(stored(legacyDoc(block, heading)))

    const blocks = bodyOf(result.state).content.map((converted: JSONContent) => [
      converted.type,
      converted.attrs?.lineHeight ?? null,
      converted.content?.[0].text,
    ])
    expect(blocks).toEqual([
      ['paragraph', '100%', 'one'],
      ['heading', null, 'Two'],
    ])
  })

  it("keeps Drive's indent and heading line height, drawn as Drive drew them", () => {
    const block = yParagraph('one')
    block.setAttribute('indent', 24 as never)
    const heading = yHeading('Two')
    heading.setAttribute('indent', 48 as never)
    heading.setAttribute('lineHeight', '150%')

    const result = convert(stored(legacyDoc(block, heading)))

    expect(bodyOf(result.state).content.map((converted: JSONContent) => converted.attrs)).toEqual([
      expect.objectContaining({ indent: 24, lineHeight: null }),
      expect.objectContaining({ indent: 48, lineHeight: '150%' }),
    ])
    expect(blockLayout(result.state)).toEqual([
      ['p', '24px', 'important', ''],
      ['h2', '48px', 'important', '150%'],
    ])
    expect(result.dropped).toEqual([])
  })

  it('keeps a negative indent and one past the widest Drive offered', () => {
    const block = yParagraph('one')
    block.setAttribute('indent', -24 as never)
    const heading = yHeading('Two')
    heading.setAttribute('indent', 264 as never)

    const result = convert(stored(legacyDoc(block, heading)))

    expect(blockLayout(result.state)).toEqual([
      ['p', '-24px', 'important', ''],
      ['h2', '264px', 'important', ''],
    ])
  })

  it.each([
    { name: 'a text zero indent', build: yParagraph, indent: '0' },
    { name: 'an indent in px', build: yParagraph, indent: '24px' },
    { name: 'an indent as text', build: yHeading, indent: '24' },
    { name: 'a fractional indent', build: yHeading, indent: 24.5 },
  ])('refuses a Yjs body holding $name', ({ build, indent }) => {
    const block = build('one')
    block.setAttribute('indent', indent as never)

    expect(convertLegacy(stored(legacyDoc(block)), MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it('refuses a Yjs list item holding a zero indent Drive never wrote there', () => {
    const item = yElement('listItem', yParagraph('one'))
    item.setAttribute('indent', 0 as never)

    expect(convertLegacy(stored(legacyDoc(yElement('bulletList', item))), MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it("keeps Drive's Yjs alignment on paragraphs and headings", () => {
    const centred = yParagraph('one')
    centred.setAttribute('textAlign', 'center')
    const heading = yHeading('Two')
    heading.setAttribute('textAlign', 'right')
    const left = yParagraph('three')
    left.setAttribute('textAlign', 'left')

    const result = convert(stored(legacyDoc(centred, heading, left)))

    expect(alignments(result.state)).toEqual({
      stored: ['center', 'right', 'left'],
      drawn: ['center', 'right', 'left'],
    })
    expect(result.dropped).toEqual([])
  })

  it("converts Drive's HTML blocks that hold its default indent (R331)", () => {
    const indent = 'style="margin-left: 0px!important;"'
    const html = `<p ${indent}>one</p><h2 ${indent}>Two</h2>`

    const result = convert({ content: null, html, collab: 0 })

    const blocks = bodyOf(result.state).content.map((block: JSONContent) => [
      block.type,
      block.content?.[0].text,
    ])
    expect(blocks).toEqual([
      ['paragraph', 'one'],
      ['heading', 'Two'],
    ])
    expect(blockLayout(result.state)).toEqual([
      ['p', '', '', ''],
      ['h2', '', '', ''],
    ])
  })

  it("keeps Drive's HTML indent and heading line height, bar its default line height", () => {
    const indent = 'margin-left: 24px!important;'
    const html =
      `<p style="${indent}">one</p><h2 style="${indent} line-height: 150%">Two</h2>` +
      '<h3 style="line-height: 100%">Three</h3>'

    const result = convert({ content: null, html, collab: 0 })

    expect(blockLayout(result.state)).toEqual([
      ['p', '24px', 'important', ''],
      ['h2', '24px', 'important', '150%'],
      ['h3', '', '', ''],
    ])
    expect(result.dropped).toEqual([])
  })

  it('keeps HTML alignment on paragraphs and headings', () => {
    const html = '<p style="text-align: center">one</p><h2 style="text-align: justify">Two</h2>'

    const result = convert({ content: null, html, collab: 0 })

    expect(alignments(result.state)).toEqual({
      stored: ['center', 'justify'],
      drawn: ['center', 'justify'],
    })
    expect(result.dropped).toEqual([])
  })

  it.each([
    { name: "indented without Drive's priority", html: '<p style="margin-left: 24px">one</p>' },
    { name: "indented in a unit Drive didn't write", html: '<p style="margin-left: 2em">one</p>' },
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

  it('converts a Yjs text style with a line height and keeps the line height', () => {
    const style = { textStyle: { color: 'red', lineHeight: '1.5' } }

    const result = convert(stored(legacyDoc(yMarked('tall', style))))

    const [{ content }] = bodyOf(result.state).content
    expect(content).toEqual([
      {
        type: 'text',
        text: 'tall',
        marks: [
          {
            type: 'textStyle',
            attrs: expect.objectContaining({ color: 'red', lineHeight: '1.5' }),
          },
        ],
      },
    ])
  })

  it('converts a Yjs text style whose values are all empty', () => {
    const empty = { color: null, fontFamily: null, fontSize: null, lineHeight: null }
    const style = { textStyle: { ...empty, backgroundColor: null } }

    const result = convert(stored(legacyDoc(yMarked('plain', style))))

    const [{ content }] = bodyOf(result.state).content
    expect(content.map(({ text }: { text: string }) => text)).toEqual(['plain'])
  })

  it('reads a line height on an HTML span as the text style line height', () => {
    const html = '<p><span style="line-height: 1.5">tall</span></p>'

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(content).toEqual([
      {
        type: 'text',
        text: 'tall',
        marks: [{ type: 'textStyle', attrs: expect.objectContaining({ lineHeight: '1.5' }) }],
      },
    ])
  })

  it.each([
    { value: '#dc2626', name: 'red' },
    { value: '#1579d0', name: 'blue' },
    { value: '#1579D0', name: 'blue' },
    { value: 'rgb(220, 38, 38)', name: 'red' },
    { value: '#dd2222', name: 'red' },
    { value: 'pink', name: 'pink' },
    { value: '#6b7280', name: 'gray' },
    { value: 'rgb(107, 114, 128)', name: 'gray' },
    { value: '#808080', name: 'gray' },
    { value: ' #dc2626 ', name: 'red' },
    { value: 'var(--prose-color-red)', name: 'red' },
  ])('reads an old Yjs text colour $value as the palette colour $name', ({ value, name }) => {
    const result = convert(stored(legacyDoc(yMarked('word', { textStyle: { color: value } }))))

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['word', [['textStyle', name]]]])
  })

  it.each([
    '#1F272E',
    '#1f272e',
    'rgb(31, 39, 46)',
    'RGB(31, 39, 46)',
    '',
    'black',
    ' Black ',
    '#000000',
    'rgb(0, 0, 0)',
    '#111111',
    '#333333',
  ])(
    'drops an old Yjs text colour %j that looks like the default text or none, and keeps the rest of the style',
    (value) => {
      const style = { textStyle: { color: value, fontSize: '20px' } }

      const result = convert(stored(legacyDoc(yMarked('word', style))))

      const [{ content }] = bodyOf(result.state).content
      expect(content[0].marks).toEqual([
        { type: 'textStyle', attrs: expect.objectContaining({ color: null, fontSize: '20px' }) },
      ])
    },
  )

  it.each([
    '#333',
    'navy',
    'grey',
    '#6b7280junk',
    'x #6b7280 y',
    'rgb(107,114,128) junk',
    '#dc2626junk',
  ])('refuses an old Yjs text colour %s with no palette colour', (value) => {
    const legacy = stored(legacyDoc(yMarked('word', { textStyle: { color: value } })))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('reads an old colour on a mention as its palette colour', () => {
    const mention = yAtom('mention', { id: 'x', label: 'Ann' })
    mention.setAttribute('textStyle', { color: '#dc2626' } as never)
    const legacy = stored(legacyDoc(yElement('paragraph', new XmlText('hi '), mention)))

    const result = convert(legacy)

    const shownMention = openConverted(result.state).state.doc.firstChild!.child(1)
    expect(shownMention.marks.map((mark) => mark.toJSON())).toEqual([
      { type: 'textStyle', attrs: expect.objectContaining({ color: 'red' }) },
    ])
  })

  it("moves an old Yjs text style's background colour onto the highlight as its palette colour", () => {
    const legacy = stored(legacyDoc(yMarked('lit', { textStyle: { backgroundColor: '#fef9c3' } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(content[0].marks).toEqual([
      { type: 'namedHighlight', attrs: expect.objectContaining({ color: 'yellow' }) },
    ])
  })

  it.each([
    { value: '#e5e7eb', drawn: [['namedHighlight', 'gray']] },
    { value: 'rgb(229, 231, 235)', drawn: [['namedHighlight', 'gray']] },
    { value: 'transparent', drawn: [] },
    { value: 'rgba(254, 249, 195, 0)', drawn: [] },
    { value: 'rgb(254 249 195 / 0)', drawn: [] },
    { value: '#ffffff', drawn: [] },
    { value: 'rgb(255,255,255)', drawn: [] },
    { value: '#fafafa', drawn: [] },
    { value: 'rgba(255,255,255,0.5)', drawn: [] },
    { value: '#d1d5db', drawn: [['namedHighlight', 'gray']] },
    { value: '#f3f4f6', drawn: [] },
    { value: '#f1f2f4', drawn: [['namedHighlight', 'gray']] },
    { value: '#f6f2f1', drawn: [] },
    { value: '#f6f7eb', drawn: [] },
    { value: '#eafff1', drawn: [] },
    { value: '#e4fefa', drawn: [] },
    { value: '#f2f3f5', drawn: [] },
  ])('reads an old Yjs background colour $value as the highlight drawn', ({ value, drawn }) => {
    const legacy = stored(legacyDoc(yMarked('lit', { textStyle: { backgroundColor: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', drawn]])
  })

  it.each(['black', 'navy', '#6b7280junk', 'x #6b7280 y', 'rgb(107,114,128) junk', 'x #fef9c3'])(
    'refuses an old Yjs background colour %s',
    (value) => {
      const legacy = stored(legacyDoc(yMarked('lit', { textStyle: { backgroundColor: value } })))

      expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
    },
  )

  it.each([
    { value: '#fef9c3', drawn: [['namedHighlight', 'yellow']] },
    { value: '#e5e7eb', drawn: [['namedHighlight', 'gray']] },
    { value: 'yellow', drawn: [['namedHighlight', 'yellow']] },
    { value: 'transparent', drawn: [] },
    { value: '', drawn: [] },
  ])('reads an old Yjs highlight $value as the highlight drawn', ({ value, drawn }) => {
    const legacy = stored(legacyDoc(yMarked('lit', { namedHighlight: { color: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', drawn]])
  })

  it('refuses an old Yjs highlight black', () => {
    const legacy = stored(legacyDoc(yMarked('lit', { namedHighlight: { color: 'black' } })))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it.each([{}, { textStyle: { backgroundColor: '#fef9c3' } }])(
    'refuses an old Yjs highlight whose colour is not text, with the style %j',
    (style) => {
      const legacy = stored(legacyDoc(yMarked('lit', { ...style, namedHighlight: { color: 5 } })))

      expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
    },
  )

  it('reads an old highlight on a mention as its palette colour', () => {
    const mention = yAtom('mention', { id: 'x', label: 'Ann' })
    mention.setAttribute('namedHighlight', { color: '#fef9c3' } as never)
    const legacy = stored(legacyDoc(yElement('paragraph', new XmlText('hi '), mention)))

    const result = convert(legacy)

    const shownMention = openConverted(result.state).state.doc.firstChild!.child(1)
    expect(shownMention.marks.map((mark) => mark.toJSON())).toEqual([
      { type: 'namedHighlight', attrs: expect.objectContaining({ color: 'yellow' }) },
    ])
  })

  it.each([
    { value: '#e5e7eb', held: 'gray', drawn: [['namedHighlight', 'gray']] },
    { value: 'transparent', held: 'yellow', drawn: [['namedHighlight', 'yellow']] },
    { value: '#fef9c3', held: '', drawn: [['namedHighlight', 'yellow']] },
  ])(
    'reads an old background colour $value over a $held highlight as the highlight drawn',
    ({ value, held, drawn }) => {
      const marks = { textStyle: { backgroundColor: value }, namedHighlight: { color: held } }

      const result = convert(stored(legacyDoc(yMarked('lit', marks))))

      const [{ content }] = bodyOf(result.state).content
      expect(drawnColours(content)).toEqual([['lit', drawn]])
    },
  )

  it('converts an old background colour over a highlight of the same colour', () => {
    const marks = { textStyle: { backgroundColor: '#fef9c3' }, namedHighlight: { color: 'yellow' } }

    const result = convert(stored(legacyDoc(yMarked('lit', marks))))

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', [['namedHighlight', 'yellow']]]])
  })

  it.each([
    { value: '#fef9c3', held: 'red' },
    { value: '#e5e7eb', held: 'yellow' },
  ])('refuses an old background colour $value over a $held highlight', ({ value, held }) => {
    const marks = { textStyle: { backgroundColor: value }, namedHighlight: { color: held } }
    const legacy = stored(legacyDoc(yMarked('lit', marks)))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it.each(['color', 'backgroundColor', 'fontFamily', 'fontSize', 'lineHeight'])(
    "refuses a Yjs text style whose %s holds a ';', which would end its style where it's drawn",
    (key) => {
      const style = { textStyle: { [key]: 'x; color: #dc2626' } }
      const legacy = stored(legacyDoc(yMarked('word', style)))

      expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
    },
  )

  it("refuses an HTML font family holding a ';' inside its quotes", () => {
    const html = `<p><span style="font-family: 'a; color: red'">word</span></p>`

    expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it("converts a Yjs text style whose values hold no ';'", () => {
    const style = { color: 'red', fontFamily: 'Inter', fontSize: '20px', lineHeight: '1.5' }

    const result = convert(stored(legacyDoc(yMarked('word', { textStyle: style }))))

    const [{ content }] = bodyOf(result.state).content
    expect(content[0].marks).toEqual([{ type: 'textStyle', attrs: expect.objectContaining(style) }])
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

  it("drops Drive's ink inside Drive's highlight, whose colour is inherit", () => {
    const highlight = 'data-color="#fef08a" style="background-color: #fef08a; color: inherit"'
    const html = `<p><mark ${highlight}>a<span ${INK}>b</span></mark></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    const yellow = [['namedHighlight', 'yellow']]
    expect(drawnColours(content)).toEqual([
      ['a', yellow],
      ['b', yellow],
    ])
  })

  it("drops Drive's ink inside a span whose colour is inherit", () => {
    const html = `<p><span style="color: inherit">a<span ${INK}>b</span></span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['ab', []]])
  })

  it("refuses Drive's ink under formatting inside a coloured span", () => {
    const red = 'style="color: #dc2626"'
    const html = `<p><span ${red}>a<strong><span ${INK}>b</span></strong></span></p>`

    expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it("refuses Drive's ink inside an important colour beside inherit, which still draws", () => {
    const red = 'style="color: #dc2626 !important; color: inherit"'
    const html = `<p><span ${red}>a<span ${INK}>b</span></span></p>`

    expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })
})

describe('convertLegacy on the raw HTML (R439)', () => {
  it.each(['foo-bar: 1', 'color: notacolour', 'color red', 'color: #dc2626 !important'])(
    'refuses a span styled "%s", which the editor would lose',
    (style) => {
      const html = `<p>a<span style="${style}">b</span></p>`

      expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
        kind: 'failed',
        reason: 'check',
      })
    },
  )

  it("refuses a font shorthand whose other longhands the editor doesn't keep", () => {
    const html = '<p>a<span style="font: 12px Arial; font-size: 20px">b</span></p>'

    expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it("refuses a class the editor doesn't draw", () => {
    const html = '<p class="MsoNormal">one</p>'

    expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it("converts Word's own style properties, recording each once", () => {
    const word = 'style="mso-spacerun: yes"'
    const html = `<p style="mso-line-height-rule: exactly"><span ${word}>a</span> <span ${word}>b</span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [block] = bodyOf(result.state).content
    expect(block.content.map(({ text }: JSONContent) => text).join('')).toBe('a b')
    expect(result.dropped).toEqual([
      { kind: 'noise', name: 'mso-line-height-rule' },
      { kind: 'noise', name: 'mso-spacerun' },
    ])
  })

  it('converts a spellcheck, recording it', () => {
    const result = convert({ content: null, html: '<p spellcheck="false">one</p>', collab: 0 })

    expect(result.dropped).toEqual([{ kind: 'noise', name: 'spellcheck' }])
  })

  it('records an image loading hint the editor draws as its own loading="false"', () => {
    const html = `<p><img src="${SRC}" loading="lazy"></p>`

    const result = convert({ content: null, html, collab: 0 })

    expect(result.dropped).toEqual([{ kind: 'noise', name: 'loading' }])
  })
})

describe('convertLegacy on old HTML spans', () => {
  const YELLOW = 'background-color: #fef08a'

  it("keeps a span's background as the highlight on the same characters", () => {
    const html = `<p>a<span style="${YELLOW}">b</span>c</p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', [['namedHighlight', 'yellow']]],
      ['c', []],
    ])
    expect(result.dropped).toEqual([])
  })

  it("keeps a span's colour as the text colour and its background as the highlight", () => {
    const html = `<p><span style="color: #dc2626; ${YELLOW}">b</span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      [
        'b',
        [
          ['textStyle', 'red'],
          ['namedHighlight', 'yellow'],
        ],
      ],
    ])
  })

  it('keeps nested spans as one text style holding both', () => {
    const html = '<p><span style="color: #dc2626"><span style="font-size: 18px">b</span></span></p>'

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    const style = { color: 'red', fontSize: '18px' }
    expect(content[0].marks).toEqual([{ type: 'textStyle', attrs: expect.objectContaining(style) }])
  })

  it("keeps the inner span's size where nested spans both set one", () => {
    const html =
      '<p><span style="font-size: 12px"><span style="font-size: 18px">b</span></span></p>'

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    const style = { fontSize: '18px' }
    expect(content[0].marks).toEqual([{ type: 'textStyle', attrs: expect.objectContaining(style) }])
  })

  it("keeps an inner span's background as the highlight under the outer span's size", () => {
    const html = `<p><span style="font-size: 18px"><span style="${YELLOW}">b</span></span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(content[0].marks).toEqual([
      { type: 'textStyle', attrs: expect.objectContaining({ fontSize: '18px' }) },
      { type: 'namedHighlight', attrs: { color: 'yellow' } },
    ])
  })

  it.each(['0.5em', '150%', 'smaller', 'larger'])(
    'refuses a relative font size %s inside a span setting a size',
    (size) => {
      const inner = `<span style="font-size: ${size}">b</span>`
      const html = `<p><span style="font-size: 18px">${inner}</span></p>`

      expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
        kind: 'failed',
        reason: 'check',
      })
    },
  )

  it.each(['transparent', ''])('refuses a span background of "%s"', (value) => {
    const html = `<p>a<span style="background-color: ${value}">b</span></p>`

    expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it('keeps a span background of inherit as no highlight, which it sets none of', () => {
    const html = '<p>a<span style="background-color: inherit">b</span></p>'

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    const types = content.flatMap(({ marks = [] }: JSONContent) => marks.map(({ type }) => type))
    expect([content.map(({ text }: JSONContent) => text).join(''), types]).toEqual([
      'ab',
      ['textStyle'],
    ])
    expect(result.dropped).toEqual([])
  })
})

describe("convertLegacy on old Drive's highlight colours (R523)", () => {
  // Old Drive's highlight picker, from its DocMenuAndInfoBar
  const OLD_HIGHLIGHTS = [
    ['yellow', '#fef9c3', 'rgb(254, 249, 195)'],
    ['orange', '#ffedd5', 'rgb(255, 237, 213)'],
    ['red', '#fee2e2', 'rgb(254, 226, 226)'],
    ['green', '#dcfce7', 'rgb(220, 252, 231)'],
    ['blue', '#D3E9FC', 'rgb(211, 233, 252)'],
    ['purple', '#f3e8ff', 'rgb(243, 232, 255)'],
    ['pink', '#fce7f3', 'rgb(252, 231, 243)'],
  ]
  const FORMS = OLD_HIGHLIGHTS.flatMap(([name, hex, rgb]) =>
    [hex, rgb, rgb.replaceAll(' ', '')].map((value) => ({ name, value })),
  )

  it.each(FORMS)('keeps an HTML span background $value as $name', ({ name, value }) => {
    const html = `<p>a<span style="background-color: ${value}">b</span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', [['namedHighlight', name]]],
    ])
    expect(result.dropped).toEqual([])
  })

  it.each(FORMS)("keeps Drive's HTML highlight $value as $name", ({ name, value }) => {
    const mark = `<mark data-color="${value}" style="background-color: ${value}; color: inherit">`
    const html = `<p>a${mark}b</mark></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', [['namedHighlight', name]]],
    ])
  })

  it.each(FORMS)('keeps an old Yjs highlight $value as $name', ({ name, value }) => {
    const legacy = stored(legacyDoc(yMarked('lit', { namedHighlight: { color: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', [['namedHighlight', name]]]])
  })

  it.each(FORMS)('keeps an old Yjs background colour $value as $name', ({ name, value }) => {
    const legacy = stored(legacyDoc(yMarked('lit', { textStyle: { backgroundColor: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', [['namedHighlight', name]]]])
  })
})

describe('convertLegacy on nested spans resetting a style (R525)', () => {
  const OUTER = { 'font-size': '18px', 'font-family': 'Arial', 'line-height': '1.5' }
  const RESETS = Object.entries(OUTER).flatMap(([property, outer]) =>
    ['inherit', 'unset', 'revert'].map((reset) => ({ property, outer, reset })),
  )

  it.each(RESETS)(
    'refuses an inner $property: $reset under $outer',
    ({ property, outer, reset }) => {
      const inner = `<span style="${property}: ${reset}">b</span>`
      const html = `<p><span style="${property}: ${outer}">a${inner}</span></p>`

      expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
        kind: 'failed',
        reason: 'check',
      })
    },
  )
})

describe("convertLegacy on old Drive's text colours", () => {
  // Old Drive's font colour picker, from its DocMenuAndInfoBar
  const OLD_TEXT_COLOURS = [
    ['yellow', '#ca8a04', 'rgb(202, 138, 4)'],
    ['orange', '#ea580c', 'rgb(234, 88, 12)'],
    ['red', '#dc2626', 'rgb(220, 38, 38)'],
    ['green', '#16a34a', 'rgb(22, 163, 74)'],
    ['blue', '#1579D0', 'rgb(21, 121, 208)'],
    ['purple', '#9333ea', 'rgb(147, 51, 234)'],
    ['pink', '#db2777', 'rgb(219, 39, 119)'],
  ]
  const FORMS = OLD_TEXT_COLOURS.flatMap(([name, hex, rgb]) =>
    [hex, rgb, rgb.replaceAll(' ', '')].map((value) => ({ name, value })),
  )

  it.each(FORMS)('keeps an HTML span colour $value as $name', ({ name, value }) => {
    const html = `<p>a<span style="color: ${value}">b</span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', [['textStyle', name]]],
    ])
    expect(result.dropped).toEqual([])
  })

  it.each(FORMS)('keeps an old Yjs text colour $value as $name', ({ name, value }) => {
    const legacy = stored(legacyDoc(yMarked('lit', { textStyle: { color: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', [['textStyle', name]]]])
  })
})

describe("convertLegacy on old Drive's highlights with a percent alpha (R531)", () => {
  const OPAQUE = ['rgba(254, 249, 195, 100%)', 'rgb(254 249 195 / 100%)']
  const EIGHT_DIGITS = '#fef9c3ff'

  it.each(OPAQUE)('keeps an HTML span background %s as yellow', (value) => {
    const html = `<p>a<span style="background-color: ${value}">b</span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', [['namedHighlight', 'yellow']]],
    ])
  })

  it.each(OPAQUE)("keeps Drive's HTML highlight %s as yellow", (value) => {
    const mark = `<mark data-color="${value}" style="background-color: ${value}; color: inherit">`
    const html = `<p>a${mark}b</mark></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', [['namedHighlight', 'yellow']]],
    ])
  })

  it.each(OPAQUE)('keeps an old Yjs highlight %s as yellow', (value) => {
    const legacy = stored(legacyDoc(yMarked('lit', { namedHighlight: { color: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', [['namedHighlight', 'yellow']]]])
  })

  it.each(OPAQUE)('keeps an old Yjs background colour %s as yellow', (value) => {
    const legacy = stored(legacyDoc(yMarked('lit', { textStyle: { backgroundColor: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', [['namedHighlight', 'yellow']]]])
  })

  it('refuses an old Yjs highlight in 8-digit hex', () => {
    const legacy = stored(legacyDoc(yMarked('lit', { namedHighlight: { color: EIGHT_DIGITS } })))

    expect(convertLegacy(legacy, MAX_STATE)).toEqual({ kind: 'failed', reason: 'check' })
  })

  it('keeps an HTML span background in 8-digit hex as yellow', () => {
    const html = `<p>a<span style="background-color: ${EIGHT_DIGITS}">b</span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', [['namedHighlight', 'yellow']]],
    ])
  })
})

describe('convertLegacy on highlight colours no one could see (R533)', () => {
  const SEE_THROUGH = ['rgba(254, 249, 195, 0)', 'rgba(220, 38, 38, 0)', 'rgb(254 249 195 / 0%)']

  it.each(SEE_THROUGH)('keeps an HTML span background %s as no highlight', (value) => {
    const html = `<p>a<span style="background-color: ${value}">b</span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', []],
    ])
    expect(result.dropped).toEqual([])
  })

  it.each(SEE_THROUGH)("keeps Drive's HTML highlight %s as no highlight", (value) => {
    const mark = `<mark data-color="${value}" style="background-color: ${value}; color: inherit">`
    const html = `<p>a${mark}b</mark></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['ab', []]])
    expect(result.dropped).toEqual([])
  })

  it('refuses a see-through HTML highlight holding more than its colour', () => {
    const mark = '<mark style="background-color: rgba(254, 249, 195, 0)" title="t">'
    const html = `<p>a${mark}b</mark></p>`

    expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })

  it.each(SEE_THROUGH)('keeps an old Yjs highlight %s as no highlight', (value) => {
    const legacy = stored(legacyDoc(yMarked('lit', { namedHighlight: { color: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', []]])
  })

  it.each(SEE_THROUGH)('keeps an old Yjs background colour %s as no highlight', (value) => {
    const legacy = stored(legacyDoc(yMarked('lit', { textStyle: { backgroundColor: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', []]])
  })
})

describe("convertLegacy on old Drive's yellow at half alpha", () => {
  // A see-through tone isn't the one old Drive's picker drew, so it goes by distance
  const HALF = 'rgba(254, 249, 195, 0.5)'

  it('keeps an HTML span background by distance, not as yellow', () => {
    const html = `<p>a<span style="background-color: ${HALF}">b</span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', [['namedHighlight', 'orange']]],
    ])
  })

  it('keeps an old Yjs highlight by distance, not as yellow', () => {
    const legacy = stored(legacyDoc(yMarked('lit', { namedHighlight: { color: HALF } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', [['namedHighlight', 'orange']]]])
  })
})

describe('convertLegacy on a highlight whose colours disagree (R534, R535)', () => {
  const SEE_THROUGH = 'rgba(254, 249, 195, 0)'
  const DISAGREEING = [
    { background: SEE_THROUGH, dataColor: '#fef9c3' },
    { background: SEE_THROUGH, dataColor: '#fee2e2' },
    { background: '#fee2e2', dataColor: '#fef9c3' },
  ]
  const AGREEING = [
    { background: '#fef9c3', dataColor: 'rgb(254, 249, 195)' },
    { background: 'rgb(254, 249, 195)', dataColor: '#FEF9C3' },
  ]

  it.each(DISAGREEING)(
    'refuses an HTML highlight $background with data-color $dataColor',
    ({ background, dataColor }) => {
      const style = `background-color: ${background}; color: inherit`
      const html = `<p>a<mark data-color="${dataColor}" style="${style}">b</mark></p>`

      expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
        kind: 'failed',
        reason: 'check',
      })
    },
  )

  it.each(AGREEING)(
    'keeps an HTML highlight $background with data-color $dataColor as yellow',
    ({ background, dataColor }) => {
      const style = `background-color: ${background}; color: inherit`
      const html = `<p>a<mark data-color="${dataColor}" style="${style}">b</mark></p>`

      const result = convert({ content: null, html, collab: 0 })

      const [{ content }] = bodyOf(result.state).content
      expect(drawnColours(content)).toEqual([
        ['a', []],
        ['b', [['namedHighlight', 'yellow']]],
      ])
      expect(result.dropped).toEqual([])
    },
  )

  it('refuses a see-through HTML highlight with another inherited style', () => {
    const mark = `<mark style="background-color: ${SEE_THROUGH}; display: inherit">`
    const html = `<p>a${mark}b</mark></p>`

    expect(convertLegacy({ content: null, html, collab: 0 }, MAX_STATE)).toEqual({
      kind: 'failed',
      reason: 'check',
    })
  })
})

describe('convertLegacy on a highlight alpha outside 0 to 1 (R536)', () => {
  const ALPHAS = [
    { value: 'rgba(254, 249, 195, -1)', drawn: [] },
    { value: 'rgba(254, 249, 195, 150%)', drawn: [['namedHighlight', 'yellow']] },
    { value: 'rgba(254, 249, 195, 2)', drawn: [['namedHighlight', 'yellow']] },
  ]

  it.each(ALPHAS)('keeps an HTML span background $value as $drawn', ({ value, drawn }) => {
    const html = `<p>a<span style="background-color: ${value}">b</span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', drawn],
    ])
  })

  it.each(ALPHAS)('keeps an old Yjs highlight $value as $drawn', ({ value, drawn }) => {
    const legacy = stored(legacyDoc(yMarked('lit', { namedHighlight: { color: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', drawn]])
  })
})

describe('convertLegacy on text colours no one could see (R537)', () => {
  const SEE_THROUGH = ['rgba(220, 38, 38, 0)', 'rgba(254, 249, 195, 0)', 'rgb(220 38 38 / 0%)']

  it.each(SEE_THROUGH)('keeps an HTML span colour %s as no colour', (value) => {
    const html = `<p>a<span style="color: ${value}">b</span></p>`

    const result = convert({ content: null, html, collab: 0 })

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([
      ['a', []],
      ['b', []],
    ])
    expect(result.dropped).toEqual([])
  })

  it.each(SEE_THROUGH)('keeps an old Yjs text colour %s as no colour', (value) => {
    const legacy = stored(legacyDoc(yMarked('lit', { textStyle: { color: value } })))

    const result = convert(legacy)

    const [{ content }] = bodyOf(result.state).content
    expect(drawnColours(content)).toEqual([['lit', []]])
  })
})
