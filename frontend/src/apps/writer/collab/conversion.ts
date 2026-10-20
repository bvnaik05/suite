import { generateJSON, getSchema, type JSONContent } from '@tiptap/core'
import { DOMSerializer, type Node as PMNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import {
  placeFragment,
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from '@tiptap/y-tiptap'
import {
  applyUpdate,
  ContentDeleted,
  ContentEmbed,
  ContentFormat,
  ContentString,
  ContentType,
  decodeUpdateV2,
  Doc,
  encodeStateAsUpdate,
  Item,
  XmlElement,
  XmlFragment,
  XmlText,
  type AbstractStruct,
  type AbstractType,
  type XmlHook,
} from 'yjs'

import { BODY_FIELD } from '@/apps/writer/collab/field'
import { domInventory, inventory, unkept, type Inventory } from '@/apps/writer/collab/inventory'
import {
  dropCommentMarks,
  OLD_THREAD_TAGS,
  oldCommentAnchors,
  unreadableThreads,
} from '@/apps/writer/collab/old-comments'
import { convertOldMedia } from '@/apps/writer/collab/old-media'
import { renderedIds } from '@/apps/writer/extensions/heading-anchors'
import { writerSchema } from '@/apps/writer/schema'

const extensions = writerSchema()
const schema = getSchema(extensions)

/** An old Writer document as its row stores it. */
export interface LegacyBody {
  content: string | null
  html: string | null
  collab: number
}

/**
 * What the conversion couldn't carry over: a part the editor can't hold, a change Yjs held back,
 * the words of an old comment's copy away from its anchor, or a Yjs body holding nothing, read
 * past for the HTML.
 */
export type Dropped =
  | { kind: 'node'; name: string; text: string }
  | { kind: 'pending'; text: string; parts: string[] }
  | { kind: 'comment-copy'; id: string; text: string }
  | { kind: 'empty-yjs' }

export type Converted =
  | {
      kind: 'converted'
      state: Uint8Array
      dropped: Dropped[]
      from: 'yjs' | 'html'
      anchors: Record<string, string>
    }
  | { kind: 'failed'; reason: 'too_large' | 'check' }

function insertedText({ insert }: { insert: unknown }) {
  return typeof insert === 'string' ? insert : ''
}

function textOf(type: AbstractType<unknown> | XmlFragment | XmlText | XmlHook): string {
  if (type instanceof XmlText) {
    return type.toDelta().map(insertedText).join('')
  }

  if (type instanceof XmlElement || type instanceof XmlFragment) {
    return type.toArray().map(textOf).join('')
  }

  return ''
}

function insertedString(struct: AbstractStruct) {
  if (struct instanceof Item && struct.content instanceof ContentString) {
    return struct.content.str
  }

  return ''
}

function nameOf(type: AbstractType<unknown>) {
  if (type instanceof XmlElement) {
    return type.nodeName
  }

  return 'text'
}

// What a held-back change adds besides text: a part, a mark or an embed
function pendingPart(struct: AbstractStruct) {
  if (!(struct instanceof Item)) {
    return []
  }

  const { content } = struct
  if (content instanceof ContentType) {
    return [nameOf(content.type)]
  }

  // A mark's end is stored as the same key set to null
  if (content instanceof ContentFormat && content.value !== null) {
    return [`format ${content.key}`]
  }

  if (content instanceof ContentEmbed) {
    return ['embed']
  }

  const isTextOrNone = [ContentString, ContentDeleted, ContentFormat].some(
    (kind) => content instanceof kind,
  )
  if (isTextOrNone) {
    return []
  }

  return ['other']
}

// Changes Yjs keeps waiting, in its V2 encoding, for earlier ones that were never stored
function pendingDrop(doc: Doc): Dropped[] {
  const pending = doc.store.pendingStructs
  if (!pending) {
    return []
  }

  const { structs } = decodeUpdateV2(pending.update)
  const text = structs.map(insertedString).join('')
  const parts = [...new Set(structs.flatMap(pendingPart))]
  if (!text && !parts.length) {
    return []
  }

  return [{ kind: 'pending', text, parts }]
}

function isContent(type: AbstractType<unknown>) {
  if (type instanceof XmlText) {
    return type.length > 0
  }

  return (
    type instanceof XmlElement &&
    (isAtomName(type.nodeName) || Object.keys(type.getAttributes()).length > 0)
  )
}

// A lost part holds content when it, or anything in it, is text, an atom or a stored attribute
function holdsContent(part: AbstractType<unknown>) {
  if (isContent(part)) {
    return true
  }

  return part instanceof XmlElement && !part.createTreeWalker(isContent).next().done
}

// Drive's table of contents, drawn from the headings, stores only the hint it showed
const OLD_TOC = 'tocNode'

function isHintOnlyToc(part: AbstractType<unknown>) {
  return (
    part instanceof XmlElement &&
    part.nodeName === OLD_TOC &&
    Object.keys(part.getAttributes()).every((key) => key === 'placeholder') &&
    !!part.createTreeWalker(isContent).next().done
  )
}

function isDroppable(part: AbstractType<unknown>) {
  return isHintOnlyToc(part) || !holdsContent(part)
}

// Blocks that hold no words when empty, and the line break, which never does
const WORDLESS = new Set(['paragraph', 'heading', 'hardBreak'])

function isWordOrPart(type: AbstractType<unknown>) {
  if (type instanceof XmlText) {
    return type.length > 0
  }

  if (isHintOnlyToc(type)) {
    return false
  }

  // An atom or media holds its data whatever stray children it has
  return (
    type instanceof XmlElement &&
    (isAtomName(type.nodeName) ||
      MEDIA.has(type.nodeName) ||
      (!type.length && !WORDLESS.has(type.nodeName)))
  )
}

// No words, embeds or parts; what empty blocks store, like a heading's level, isn't counted
function holdsNothing(body: XmlFragment) {
  return !!body.createTreeWalker(isWordOrPart).next().done
}

function lostParts(lost: AbstractType<unknown>[]): Dropped[] {
  return lost.map((type) => ({ kind: 'node', name: nameOf(type), text: textOf(type) }))
}

// The id each heading's anchor already has when drawn, so links to it keep working
function withHeadingIds(node: PMNode) {
  const nextRenderedId = renderedIds()
  const transform = new Transform(node)
  node.descendants((child, pos) => {
    const isBare =
      child.type.name === 'heading' && !!child.textContent && !child.attrs['data-toc-id']
    if (isBare) {
      transform.setNodeAttribute(pos, 'data-toc-id', nextRenderedId(child.textContent))
    }
  })
  return transform.doc
}

// A line break the HTML parser had nowhere to put loses no words, so breaks aren't counted
function isAtomName(name: string) {
  const type = schema.nodes[name]
  return !!type && type.isLeaf && !type.isText && name !== 'hardBreak'
}

function decoded(content: string | null) {
  // A collaborative body with no Yjs state stored
  if (!content) {
    return null
  }

  const old = new Doc()
  try {
    applyUpdate(
      old,
      Uint8Array.from(atob(content), (char) => char.charCodeAt(0)),
    )
  } catch {
    // Bytes Yjs can't read leave the HTML
    return null
  }

  return old
}

const MEDIA = new Set(['resizableMedia', 'image', 'video'])

// Where each image and video points, in order
function mediaSources(body: XmlFragment) {
  const media = [
    ...body.createTreeWalker((type) => type instanceof XmlElement && MEDIA.has(type.nodeName)),
  ] as XmlElement[]
  return JSON.stringify(media.map((element) => element.getAttribute('src')))
}

// Drive stored its indent and heading line height at their defaults, which this editor has no attribute for
const DEFAULT_INDENTS = new Set<unknown>([0, '0'])

function dropDriveDefaults(body: XmlFragment) {
  const elements = [...body.createTreeWalker((type) => type instanceof XmlElement)] as XmlElement[]
  for (const element of elements) {
    if (DEFAULT_INDENTS.has(element.getAttribute('indent'))) {
      element.removeAttribute('indent')
    }

    if (element.nodeName === 'heading' && element.getAttribute('lineHeight') === '100%') {
      element.removeAttribute('lineHeight')
    }
  }
}

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

// The key setting an old text colour as the palette name the editor draws, empty and Drive's ink
// holding none; null when it reads as no palette colour
function textColourFormat(color: unknown): Attributes | null {
  if (typeof color !== 'string') {
    return { color }
  }

  if (!color || isDriveInk(color)) {
    return { color: null }
  }

  const name = paletteName('color', color)
  if (!name) {
    return null
  }

  return { color: name }
}

// The highlight an old background colour reads as, which must agree with one the run holds; null
// when it reads as no palette colour
function highlightFormat(backgroundColor: unknown, held: unknown): Attributes | null {
  if (backgroundColor == null || backgroundColor === '') {
    return {}
  }

  const name =
    typeof backgroundColor === 'string' && paletteName('background-color', backgroundColor)
  const heldName = (held as Attributes | undefined)?.color
  if (!name || (heldName != null && heldName !== name)) {
    return null
  }

  return { namedHighlight: { color: name } }
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
function mapOldColours(body: XmlFragment) {
  return [...body.createTreeWalker(() => true)].every((part) => {
    if (part instanceof XmlText) {
      return mapTextColours(part)
    }

    return !(part instanceof XmlElement) || mapPartColours(part)
  })
}

// Whether formatting holds a text style value with a ';', which would end its declaration where
// it's drawn
function holdsStyleBreak({ textStyle }: Attributes = {}) {
  return Object.values((textStyle ?? {}) as Attributes).some(
    (value) => typeof value === 'string' && value.includes(';'),
  )
}

function breaksStyle(body: XmlFragment) {
  return [...body.createTreeWalker(() => true)].some((part) => {
    if (part instanceof XmlText) {
      return (part.toDelta() as Run[]).some(({ attributes }) => holdsStyleBreak(attributes))
    }

    return part instanceof XmlElement && holdsStyleBreak(part.getAttributes())
  })
}

// The check compares the old body with the fresh one as Yjs holds both. Between them: convertOldMedia,
// checked on its own by where the media points; Drive's defaults, dropped; old colours, read as
// palette names, or the check fails; the parts the build set
// aside holding nothing, hidden or lost (recorded), and Drive's table of contents holding only its
// hint, left out of the source, so a lost part with content fails; and the extras the result may
// hold, being the filler the build adds, declared defaults and heading ids
function fromYjs(old: Doc) {
  const hasUnreadableThreads = unreadableThreads(old).length > 0
  const body = old.getXmlFragment(BODY_FIELD)
  const media = mediaSources(body)
  convertOldMedia(body)
  dropDriveDefaults(body)
  const isColourMapped = mapOldColours(body)
  const { node, hidden, lost } = placeFragment(body, schema)
  const isMediaKept = mediaSources(body) === media
  const source = inventory(body, new Set([...hidden, ...lost.filter(isDroppable)]))
  return {
    node,
    dropped: [...lostParts(lost), ...pendingDrop(old)],
    hasUnreadableThreads,
    isKept: (fresh: XmlFragment) =>
      isColourMapped && isMediaKept && !unkept(source, inventory(fresh)).length,
  }
}

const atomRules = Object.values(schema.nodes)
  .filter((type) => isAtomName(type.name))
  .flatMap((type) => (type.spec.parseDOM ?? []).map((rule) => ({ rule, name: type.name })))

function atomNameOf(element: Element) {
  const found = atomRules.find(
    ({ rule }) => element.matches(rule.tag) && rule.getAttrs?.(element as HTMLElement) !== false,
  )
  return found?.name
}

// Drive's ink, which it stored as the colour of text left at its default
const DRIVE_INK = 'rgb(31, 39, 46)'

// Whether a parent still sets a colour, which the editor would draw on Drive's ink inside it;
// parents are stripped first, and inherit sets none
function hasColouredAncestor(element: HTMLElement) {
  let parent = element.parentElement
  while (parent) {
    const color = parent.style.getPropertyValue('color')
    if (color && color !== 'inherit') {
      return true
    }

    parent = parent.parentElement
  }

  return false
}

// Drive stored its indent on every block and its ink on default text; a highlight also kept its
// colour in data-color, which the editor reads from the style, and a video repeated its src in a
// source
function dropDriveHtmlDefaults(body: HTMLElement) {
  for (const block of body.querySelectorAll<HTMLElement>('p, h1, h2, h3, h4, h5, h6')) {
    if (block.style.getPropertyValue('margin-left') === '0px') {
      block.style.removeProperty('margin-left')
    }
  }

  for (const element of body.querySelectorAll<HTMLElement>('[style]')) {
    if (element.style.getPropertyValue('color') === DRIVE_INK && !hasColouredAncestor(element)) {
      element.style.removeProperty('color')
    }
  }

  for (const mark of body.querySelectorAll<HTMLElement>('mark[data-color]')) {
    if (mark.style.getPropertyValue('background-color')) {
      mark.removeAttribute('data-color')
    }
  }

  for (const source of body.querySelectorAll('video > source')) {
    if (source.getAttribute('src') === source.parentElement?.getAttribute('src')) {
      source.remove()
    }
  }
}

// The fresh body as the editor draws it
function drawn(fresh: XmlFragment) {
  const { content } = yXmlFragmentToProseMirrorRootNode(fresh, schema)
  return DOMSerializer.fromSchema(schema).serializeFragment(content)
}

// The check compares the old HTML, Drive's defaults dropped, with the fresh body as the editor draws
// it; whitespace and line breaks aren't compared
function fromHtml(html: string) {
  const node = schema.nodeFromJSON(generateJSON(html, extensions))
  const { body } = new DOMParser().parseFromString(html, 'text/html')
  const hasUnreadableThreads = !!body.querySelector(OLD_THREAD_TAGS)
  dropDriveHtmlDefaults(body)
  const source = domInventory(body, atomNameOf)
  return {
    node,
    dropped: [] as Dropped[],
    hasUnreadableThreads,
    isKept: (fresh: XmlFragment) => !unkept(source, domInventory(drawn(fresh), atomNameOf)).length,
  }
}

// The HTML read in place of a Yjs body holding nothing; the Yjs document's threads still refuse it
// and its held-back changes are still recorded
function fromHtmlOverYjs(old: Doc, html: string) {
  const parsed = fromHtml(html)
  return {
    ...parsed,
    dropped: [{ kind: 'empty-yjs' } as const, ...pendingDrop(old)],
    hasUnreadableThreads: parsed.hasUnreadableThreads || unreadableThreads(old).length > 0,
  }
}

function isNotComment([key]: [string, unknown]) {
  return key !== 'comment'
}

// What a body holds apart from its old comment marks
function withoutComments({ characters, elements }: Inventory): Inventory {
  return {
    characters: characters.map((character) => ({
      ...character,
      entries: character.entries.filter(isNotComment),
    })),
    elements: elements.map((piece) => ({ ...piece, entries: piece.entries.filter(isNotComment) })),
  }
}

// Each old comment moves from its mark to an anchor; the body must then hold the same with no
// comment mark, and no comment mark may lose its thread
function moveComments(body: XmlFragment) {
  const { anchors, copies } = oldCommentAnchors(body, schema)
  const marked = withoutComments(inventory(body))
  const ids = dropCommentMarks(body, schema)
  const left = inventory(body)
  const isMoved =
    ids.every((id) => Object.hasOwn(anchors, id)) &&
    !unkept(marked, left).length &&
    !unkept(left, marked).length
  const dropped = copies.map(({ id, text }): Dropped => ({ kind: 'comment-copy', id, text }))
  return { isMoved, anchors, dropped }
}

function read(legacy: LegacyBody) {
  // A body saved without collaboration has only its HTML
  if (legacy.collab !== 0) {
    const old = decoded(legacy.content)
    if (old && holdsNothing(old.getXmlFragment(BODY_FIELD))) {
      return { ...fromHtmlOverYjs(old, legacy.html ?? ''), from: 'html' as const }
    }

    if (old) {
      return { ...fromYjs(old), from: 'yjs' as const }
    }
  }

  return { ...fromHtml(legacy.html ?? ''), from: 'html' as const }
}

/** The old document as a fresh collaborative body, checked to hold the old text, formatting and parts apart from what it drops. */
export function convertLegacy(legacy: LegacyBody, maxState: number): Converted {
  const { node, dropped, hasUnreadableThreads, isKept, from } = read(legacy)
  if (hasUnreadableThreads) {
    return { kind: 'failed', reason: 'check' }
  }

  const converted = withHeadingIds(node)
  const fresh = new Doc()
  const body = fresh.getXmlFragment(BODY_FIELD)
  prosemirrorToYXmlFragment(converted, body)
  if (!isKept(body) || breaksStyle(body)) {
    return { kind: 'failed', reason: 'check' }
  }

  const comments = moveComments(body)
  if (!comments.isMoved) {
    return { kind: 'failed', reason: 'check' }
  }

  const state = encodeStateAsUpdate(fresh)
  if (state.byteLength > maxState) {
    return { kind: 'failed', reason: 'too_large' }
  }

  const { anchors } = comments
  return { kind: 'converted', state, dropped: [...dropped, ...comments.dropped], from, anchors }
}
