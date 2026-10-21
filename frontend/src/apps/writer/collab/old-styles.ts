import { generateJSON, type JSONContent } from '@tiptap/core'
import { XmlElement, XmlFragment, XmlText } from 'yjs'

import {
  isImportantBackground,
  isKeptCellStyle,
  parseCellBackground,
  parseCellStyle,
} from '@/apps/writer/extensions/cell-style'
import { writerSchema } from '@/apps/writer/schema'
import { rgbOf, squaredDistance, type Rgb } from '@/apps/writer/utils/css-colour'

const extensions = writerSchema()

// Drive's ink, which it stored as the colour of text left at its default
export const DRIVE_INK = 'rgb(31, 39, 46)'

type Attributes = Record<string, unknown>

interface Run {
  insert: unknown
  attributes?: Attributes
}

// Where the editor reads each colour from pasted HTML, and the variable it draws a palette name with
const COLOUR_READS = {
  color: { tag: 'span', mark: 'textStyle', variable: 'prose-color' },
  'background-color': { tag: 'mark', mark: 'namedHighlight', variable: 'prose-highlight' },
}

type ColourProperty = keyof typeof COLOUR_READS

// Drive's ink as Yjs stored it, in either form
function isDriveInk(value: string) {
  return ['#1f272e', DRIVE_INK].includes(value.toLowerCase())
}

const paletteNames = new Map<string, unknown>()

// The palette name the editor reads from a colour as it reads pasted HTML, a palette name coming
// back from its variable; a ';' would end the declaration
function paletteName(property: ColourProperty, value: string) {
  const key = `${property} ${value}`
  if (value.includes(';')) {
    return null
  }

  if (paletteNames.has(key)) {
    return paletteNames.get(key)
  }

  const { tag, mark, variable } = COLOUR_READS[property]
  const element = document.createElement(tag)
  element.textContent = 'x'
  let name: unknown = null
  for (const colour of [`var(--${variable}-${value})`, value]) {
    element.setAttribute('style', `${property}: ${colour}`)
    const json: JSONContent = generateJSON(`<p>${element.outerHTML}</p>`, extensions)
    const text = json.content?.[0]?.content?.[0]
    name = text?.marks?.find(({ type }) => type === mark)?.attrs?.color
    if (name) {
      break
    }
  }

  paletteNames.set(key, name)
  return name
}

// Old colours that look like none where they're drawn: black text is the default text, a
// see-through highlight shows the page
const LOOKS_UNSET: Record<ColourProperty, string> = {
  color: 'black',
  'background-color': 'transparent',
}

// The default text Writer draws, prose-v3's var(--ink-gray-7): frappe-ui's gray 800,
// oklch(0.341 0 0)
const INK = { red: 56, green: 56, blue: 56 }

// The anchor frappe-ui's textColorHexMap matches gray text to
const GRAY_TEXT = { red: 107, green: 114, blue: 128 }

// The page Writer draws behind the text, bg-surface-base: frappe-ui's neutral white
const PAGE = { red: 255, green: 255, blue: 255 }

// The anchor frappe-ui's highlightColorHexMap matches a gray highlight to
const GRAY_HIGHLIGHT = { red: 229, green: 231, blue: 235 }

// Where an unnamed tone lands: gray when nearer `gray`, no colour when nearer `none` or as near
const TONES: Record<ColourProperty, { gray: Rgb; none: Rgb }> = {
  color: { gray: GRAY_TEXT, none: INK },
  'background-color': { gray: GRAY_HIGHLIGHT, none: PAGE },
}

// A palette name or any var(--...) reference, with nothing around it
const WHOLE_NAME = /^([a-z]+|var\(--[a-z0-9-]+\))$/i

// Old Drive's highlight picker, from its DocMenuAndInfoBar: the editor reads these tones as their
// names only from these hexes, and matches any other form of them to a different tone
const OLD_DRIVE_HIGHLIGHTS = [
  ['yellow', '#fef9c3'],
  ['orange', '#ffedd5'],
  ['red', '#fee2e2'],
  ['green', '#dcfce7'],
  ['blue', '#D3E9FC'],
  ['purple', '#f3e8ff'],
  ['pink', '#fce7f3'],
]

function isColour(hex: string, rgb: Rgb) {
  const colour = rgbOf(hex)
  return colour !== null && squaredDistance(colour, rgb) === 0
}

// The name of a highlight colour from old Drive's picker, in any form; null for any other colour
function oldDriveName(property: ColourProperty, rgb: ReturnType<typeof rgbOf>) {
  if (property !== 'background-color' || rgb?.alpha !== 1) {
    return null
  }

  const found = OLD_DRIVE_HIGHLIGHTS.find(([, hex]) => isColour(hex, rgb))
  return found?.[0] ?? null
}

// The palette name an old colour keeps its look as, '' when it looks like none: old Drive's own,
// the one the editor reads, or for a tone it reads as none, gray or no colour by whichever is
// nearer; null when it can't be read or holds more than a colour
function oldPaletteName(property: ColourProperty, value: string): string | null {
  if (value.includes(';')) {
    return null
  }

  const rgb = rgbOf(value)
  if (rgb?.alpha === 0 || value.trim().toLowerCase() === LOOKS_UNSET[property]) {
    return ''
  }

  if (!rgb && !WHOLE_NAME.test(value.trim())) {
    return null
  }

  const name = oldDriveName(property, rgb) ?? paletteName(property, value)
  if (typeof name === 'string' && name) {
    return name
  }

  if (!rgb) {
    return null
  }

  const { gray, none } = TONES[property]
  if (squaredDistance(rgb, gray) < squaredDistance(rgb, none)) {
    return 'gray'
  }

  return ''
}

// The key setting an old text colour as the palette name the editor draws, empty, Drive's ink and
// colours that look like the default text holding none; null when it can't be read
function textColourFormat(color: unknown): Attributes | null {
  if (typeof color !== 'string') {
    return { color }
  }

  if (!color || isDriveInk(color)) {
    return { color: null }
  }

  const name = oldPaletteName('color', color)
  if (name === null) {
    return null
  }

  return { color: name || null }
}

// The palette name an old highlight colour keeps its look as, '' when there is none; null when it
// can't be read
function highlightName(value: unknown): string | null {
  if (value == null || value === '') {
    return ''
  }

  if (typeof value !== 'string') {
    return null
  }

  return oldPaletteName('background-color', value)
}

// The highlight old colours read as: a background colour, which must agree with the highlight the
// run holds, or that highlight's own colour; null when one can't be read
function highlightFormat(backgroundColor: unknown, held: unknown): Attributes | null {
  const heldColour = (held as Attributes | undefined)?.color
  const name = highlightName(backgroundColor)
  const heldName = highlightName(heldColour)
  if (name === null || heldName === null || (name && heldName && name !== heldName)) {
    return null
  }

  if (name || heldName) {
    return { namedHighlight: { color: name || heldName } }
  }

  if (heldColour == null) {
    return {}
  }

  return { namedHighlight: null }
}

// The keys that set formatting's old text style colours as palette names, its background on the
// highlight; null when one reads as no palette colour
function paletteFormat({ textStyle, namedHighlight }: Attributes): Attributes | null {
  const { color, backgroundColor, ...rest } = (textStyle ?? {}) as Attributes
  const colour = textColourFormat(color)
  const highlight = highlightFormat(backgroundColor, namedHighlight)
  if (!colour || !highlight) {
    return null
  }

  const style = { ...rest, ...colour }
  const isUnset = Object.values(style).every((value) => value == null)
  return { ...highlight, textStyle: isUnset ? null : style }
}

// Old colours on a text's runs as palette names; false when one reads as none
function mapTextColours(text: XmlText) {
  let at = 0
  for (const { insert, attributes = {} } of text.toDelta() as Run[]) {
    const format = paletteFormat(attributes)
    if (!format) {
      return false
    }

    let length = 1
    if (typeof insert === 'string') {
      length = insert.length
    }

    text.format(at, length, format)
    at += length
  }

  return true
}

// Old colours on an inline part, which holds its marks as attributes, as palette names; false when
// one reads as none
function mapPartColours(part: XmlElement) {
  const format = paletteFormat(part.getAttributes())
  if (!format) {
    return false
  }

  for (const [key, value] of Object.entries(format)) {
    if (value == null) {
      part.removeAttribute(key)
    } else {
      part.setAttribute(key, value as string)
    }
  }

  return true
}

// Writer draws a colour only as a palette name, so old Yjs colours are read as palette names the
// way pasted HTML is; false when one reads as none
export function mapOldColours(body: XmlFragment) {
  return [...body.createTreeWalker(() => true)].every((part) => {
    if (part instanceof XmlText) {
      return mapTextColours(part)
    }

    return !(part instanceof XmlElement) || mapPartColours(part)
  })
}

const CELLS = new Set(['tableCell', 'tableHeader'])

// The border frappe-ui's old table menu drew for each border colour name stored
const OLD_BORDERS = new Map([
  ['transparent', 'border: 2px solid transparent'],
  ['gray', 'border: 2px solid #999999'],
])

// The cell style an old border colour name and width drew, the width over the name's; null for a
// name or width it couldn't have drawn
function oldBorderStyle(color: unknown, width: unknown) {
  const isName = color == null || OLD_BORDERS.has(color as string)
  const isWidth = width == null || (typeof width === 'string' && /^\d+(\.\d+)?px$/.test(width))
  if (!isName || !isWidth) {
    return null
  }

  const pieces = []
  if (color != null) {
    pieces.push(OLD_BORDERS.get(color as string))
  }

  if (width != null) {
    pieces.push(`border-width: ${width}`)
  }

  return pieces.join('; ')
}

// An old border name and width moved onto the cell style; false beside a style, since the editor
// that stored them had none
function mapCellBorder(cell: XmlElement) {
  const color: unknown = cell.getAttribute('borderColor')
  const width: unknown = cell.getAttribute('borderWidth')
  if (color == null && width == null) {
    return true
  }

  const style = oldBorderStyle(color, width)
  if (style == null || cell.getAttribute('style') != null) {
    return false
  }

  cell.removeAttribute('borderColor')
  cell.removeAttribute('borderWidth')
  cell.setAttribute('style', style)
  return true
}

// A cell's style read the way pasted HTML is, its background as a highlight name when it's exactly
// one; false when it holds a property a cell doesn't keep, a background beside a name, or an
// important background a name can't carry
function mapCellStyle(cell: XmlElement) {
  if (!mapCellBorder(cell)) {
    return false
  }

  const text: unknown = cell.getAttribute('style')
  if (text == null) {
    return true
  }

  if (typeof text !== 'string' || !isKeptCellStyle(text)) {
    return false
  }

  const element = document.createElement('td')
  element.setAttribute('style', text)
  const hasName = cell.getAttribute('backgroundColor') != null
  if (hasName && element.style.getPropertyValue('background-color')) {
    return false
  }

  if (isImportantBackground(text) && parseCellBackground(element)) {
    return false
  }

  setCellStyle(cell, element)
  return true
}

function setCellStyle(cell: XmlElement, element: HTMLElement) {
  const name = parseCellBackground(element)
  if (name) {
    cell.setAttribute('backgroundColor', name)
  }

  const style = parseCellStyle(element)
  if (style) {
    cell.setAttribute('style', style)
  } else {
    cell.removeAttribute('style')
  }
}

export function mapOldCellStyles(body: XmlFragment) {
  const cells = [
    ...body.createTreeWalker((type) => type instanceof XmlElement && CELLS.has(type.nodeName)),
  ] as XmlElement[]
  return cells.every(mapCellStyle)
}

// Whether formatting holds a text style value with a ';', which would end its declaration where
// it's drawn
function holdsStyleBreak({ textStyle }: Attributes = {}) {
  return Object.values((textStyle ?? {}) as Attributes).some(
    (value) => typeof value === 'string' && value.includes(';'),
  )
}

export function breaksStyle(body: XmlFragment) {
  return [...body.createTreeWalker(() => true)].some((part) => {
    if (part instanceof XmlText) {
      return (part.toDelta() as Run[]).some(({ attributes }) => holdsStyleBreak(attributes))
    }

    return part instanceof XmlElement && holdsStyleBreak(part.getAttributes())
  })
}

// The editor reads a highlight only from a mark, so a span's background moves onto a mark around
// what the span holds; inherit sets none, and would draw a bare mark
export function moveSpanHighlights(body: HTMLElement) {
  const spans = [...body.querySelectorAll<HTMLElement>('span')].filter(
    (span) => !['', 'inherit'].includes(span.style.getPropertyValue('background-color')),
  )
  for (const span of spans) {
    const { style } = span
    const mark = body.ownerDocument.createElement('mark')
    const value = style.getPropertyValue('background-color')
    mark.style.setProperty('background-color', value, style.getPropertyPriority('background-color'))
    style.removeProperty('background-color')
    mark.append(...span.childNodes)
    span.append(mark)
  }

  return spans.length > 0
}

// The editor reads old Drive's highlights by name only from their hexes, so any form of one is
// written as the variable the editor draws that name with
export function nameOldDriveHighlights(body: HTMLElement) {
  const { variable } = COLOUR_READS['background-color']
  let isNamed = false
  for (const { style } of body.querySelectorAll<HTMLElement>('mark')) {
    const name = oldDriveName('background-color', rgbOf(style.getPropertyValue('background-color')))
    if (name) {
      const priority = style.getPropertyPriority('background-color')
      style.setProperty('background-color', `var(--${variable}-${name})`, priority)
      isNamed = true
    }
  }

  return isNamed
}

// The colours an element sets for a property; a highlight also kept its colour in data-color
function coloursOf(element: HTMLElement, property: ColourProperty) {
  const colours = [element.style.getPropertyValue(property)]
  if (property === 'background-color') {
    colours.push(element.getAttribute('data-color') ?? '')
  }

  return colours.filter((colour) => colour !== '')
}

// Whether every colour an element sets for a property is one no one could see
function isSeeThrough(element: HTMLElement, property: ColourProperty) {
  const colours = coloursOf(element, property)
  return colours.length > 0 && colours.every((colour) => rgbOf(colour)?.alpha === 0)
}

// A mark that holds nothing but its colour, Drive's inherited text colour aside
function isBareMark(mark: HTMLElement) {
  const names = [...mark.style].filter(
    (name) => name !== 'color' || mark.style.getPropertyValue(name) !== 'inherit',
  )
  const attributes = [...mark.attributes].filter(({ name }) => name !== 'style')
  return !names.length && !attributes.length
}

// A text colour no one could see shows none, as on the Yjs path, so it goes in place
export function clearSeeThroughText(body: HTMLElement) {
  const cleared = [...body.querySelectorAll<HTMLElement>('[style]')].filter((element) =>
    isSeeThrough(element, 'color'),
  )
  for (const { style } of cleared) {
    style.removeProperty('color')
  }

  return cleared.length > 0
}

// A background no one could see shows no highlight, as on the Yjs path, so it goes in place; a
// mark left with other attributes stays and fails the check
export function clearSeeThroughHighlights(body: HTMLElement) {
  const cleared = [...body.querySelectorAll<HTMLElement>('span, mark')].filter((element) =>
    isSeeThrough(element, 'background-color'),
  )
  for (const element of cleared) {
    element.style.removeProperty('background-color')
    if (element.localName !== 'mark') {
      continue
    }

    element.removeAttribute('data-color')
    if (isBareMark(element)) {
      element.replaceWith(...element.childNodes)
    }
  }

  return cleared.length > 0
}
