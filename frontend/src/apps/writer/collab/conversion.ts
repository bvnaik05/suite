import { generateJSON, getSchema } from '@tiptap/core'
import { DOMSerializer, type Node as PMNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import {
  placeFragment,
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from '@tiptap/y-tiptap'
import {
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
  type AbstractStruct,
  type AbstractType,
} from 'yjs'

import { BODY_FIELD } from '@/apps/writer/collab/field'
import {
  domInventory,
  inventory,
  NOISE_ATTRIBUTES,
  rawStyles,
  unkept,
  type Inventory,
} from '@/apps/writer/collab/inventory'
import {
  isAtomName,
  isContent,
  isHintOnlyToc,
  MEDIA,
  readLegacy,
  type LegacyBody,
  type LegacyRead,
} from '@/apps/writer/collab/legacy-read'
import {
  dropCommentMarks,
  OLD_THREAD_TAGS,
  oldCommentAnchors,
  unreadableThreads,
} from '@/apps/writer/collab/old-comments'
import {
  convertOldMedia,
  isFloatDropped,
  isOldLayout,
  isOldMediaMappable,
  oldLayout,
} from '@/apps/writer/collab/old-media'
import {
  breaksStyle,
  clearSeeThroughHighlights,
  clearSeeThroughText,
  DRIVE_INK,
  mapOldCellStyles,
  mapOldColours,
  moveSpanHighlights,
  nameOldDriveHighlights,
} from '@/apps/writer/collab/old-styles'
import { DRIVE_HEADING_LINE_HEIGHT, INDENTED_BLOCKS } from '@/apps/writer/extensions/block-layout'
import { renderedIds } from '@/apps/writer/extensions/heading-anchors'
import { writerSchema } from '@/apps/writer/schema'
import { isSameColour } from '@/apps/writer/utils/css-colour'

const extensions = writerSchema()
const schema = getSchema(extensions)

/**
 * What the conversion couldn't carry over: Drive's table of contents, rebuilt from the headings, a
 * part holding nothing, a change Yjs held back, the words of an old comment's copy away from its
 * anchor, a Yjs body holding nothing, read past for the HTML, or a property or attribute on the noise
 * list.
 */
export type Dropped =
  | { kind: 'toc-hint' }
  | { kind: 'empty'; name: string }
  | { kind: 'pending'; text: string; parts: string[] }
  | { kind: 'comment-copy'; id: string; text: string }
  | { kind: 'empty-yjs' }
  | { kind: 'noise'; name: string }

export type Converted =
  | {
      kind: 'converted'
      state: Uint8Array
      dropped: Dropped[]
      from: 'yjs' | 'html'
      anchors: Record<string, string>
    }
  | { kind: 'failed'; reason: 'too_large' | 'check' | 'unreadable-yjs' }

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

// A lost part holds content when it, or anything in it, is text, an atom or a stored attribute
function holdsContent(part: AbstractType<unknown>) {
  if (isContent(part)) {
    return true
  }

  return part instanceof XmlElement && !part.createTreeWalker(isContent).next().done
}

function isDroppable(part: AbstractType<unknown>) {
  return isHintOnlyToc(part) || !holdsContent(part)
}

function droppedPart(part: AbstractType<unknown>): Dropped {
  if (isHintOnlyToc(part)) {
    return { kind: 'toc-hint' }
  }

  return { kind: 'empty', name: nameOf(part) }
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

// Where each image and video points, in order
function mediaSources(body: XmlFragment) {
  const media = [
    ...body.createTreeWalker((type) => type instanceof XmlElement && MEDIA.has(type.nodeName)),
  ] as XmlElement[]
  return JSON.stringify(media.map((element) => element.getAttribute('src')))
}

const INDENTED = new Set(INDENTED_BLOCKS)

function elementsOf(body: XmlFragment) {
  return [...body.createTreeWalker((type) => type instanceof XmlElement)] as XmlElement[]
}

// Drive stored its indent and heading line height at defaults it never drew
function dropDriveDefaults(body: XmlFragment) {
  for (const element of elementsOf(body)) {
    const indent: unknown = element.getAttribute('indent')
    if (INDENTED.has(element.nodeName) && indent === 0) {
      element.removeAttribute('indent')
    }

    const lineHeight = element.getAttribute('lineHeight')
    if (element.nodeName === 'heading' && lineHeight === DRIVE_HEADING_LINE_HEIGHT) {
      element.removeAttribute('lineHeight')
    }
  }
}

// Drive stored an indent only as a whole number of pixels
function hasWholeIndents(body: XmlFragment) {
  return elementsOf(body).every((element) => {
    const indent: unknown = element.getAttribute('indent')
    return indent == null || Number.isInteger(indent)
  })
}

// frappe-ui left its upload id on uploaded media, which opens the caption field where it's drawn
function dropUploadIds(body: XmlFragment): Dropped[] {
  const marked = [
    ...body.createTreeWalker(
      (type) =>
        type instanceof XmlElement &&
        MEDIA.has(type.nodeName) &&
        type.getAttribute('uploadId') != null,
    ),
  ] as XmlElement[]
  for (const element of marked) {
    element.removeAttribute('uploadId')
  }

  if (!marked.length) {
    return []
  }

  return [{ kind: 'noise', name: 'uploadId' }]
}

// The old editor showed old media's alignment over its float, so a float beside one goes
function droppedFloats(body: XmlFragment): Dropped[] {
  if (!isFloatDropped(body)) {
    return []
  }

  return [{ kind: 'noise', name: 'dataFloat' }]
}

// The check compares the old body with the fresh one as Yjs holds both. Between them:
// convertOldMedia, checked on its own by where the media points and by old media holding only what
// the old editor wrote; a float beside an alignment, dropped (recorded); Drive's defaults, dropped;
// frappe-ui's upload id on media, dropped (recorded); old colours, read as palette names, or the
// check fails; cell styles, read as pasted HTML is, or the check fails; the parts the build set aside holding nothing, hidden or lost (recorded), and
// Drive's table of contents holding only its hint, left out of the source, so a lost part with
// content fails; and the extras the result may hold, being the filler the build adds, declared
// defaults and heading ids
function fromYjs(old: Doc) {
  const hasUnreadableThreads = unreadableThreads(old).length > 0
  const body = old.getXmlFragment(BODY_FIELD)
  const media = mediaSources(body)
  const isOldMediaKept = isOldMediaMappable(body)
  const floats = droppedFloats(body)
  convertOldMedia(body)
  dropDriveDefaults(body)
  const isIndentKept = hasWholeIndents(body)
  const uploadIds = dropUploadIds(body)
  const isColourMapped = mapOldColours(body)
  const isCellStyleMapped = mapOldCellStyles(body)
  const { node, hidden, lost } = placeFragment(body, schema)
  const isMediaKept = mediaSources(body) === media
  const setAside = [...hidden, ...lost.filter(isDroppable)]
  const source = inventory(body, new Set(setAside))
  return {
    node,
    dropped: [...setAside.map(droppedPart), ...pendingDrop(old)],
    hasUnreadableThreads,
    check: (fresh: XmlFragment): Dropped[] | null => {
      const isKept =
        lost.every(isDroppable) &&
        isColourMapped &&
        isCellStyleMapped &&
        isIndentKept &&
        isMediaKept &&
        isOldMediaKept &&
        !unkept(source, inventory(fresh)).length
      if (!isKept) {
        return null
      }

      return [...uploadIds, ...floats]
    },
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

// Drive stored its indent on paragraphs and headings, its heading line height and its ink on
// default text, all at their defaults; a highlight also kept its colour in data-color, which the
// editor reads from the style, so it goes only when it's the same colour; and a video repeated its
// src in a source
function dropDriveHtmlDefaults(body: HTMLElement) {
  for (const block of body.querySelectorAll<HTMLElement>('p, h1, h2, h3, h4, h5, h6')) {
    if (block.style.getPropertyValue('margin-left') === '0px') {
      block.style.removeProperty('margin-left')
    }
  }

  for (const heading of body.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    if (heading.style.getPropertyValue('line-height') === DRIVE_HEADING_LINE_HEIGHT) {
      heading.style.removeProperty('line-height')
    }
  }

  for (const element of body.querySelectorAll<HTMLElement>('[style]')) {
    if (element.style.getPropertyValue('color') === DRIVE_INK && !hasColouredAncestor(element)) {
      element.style.removeProperty('color')
    }
  }

  for (const mark of body.querySelectorAll<HTMLElement>('mark[data-color]')) {
    const background = mark.style.getPropertyValue('background-color')
    if (background && isSameColour(background, mark.getAttribute('data-color') ?? '')) {
      mark.removeAttribute('data-color')
    }
  }

  for (const source of body.querySelectorAll('video > source')) {
    if (source.getAttribute('src') === source.parentElement?.getAttribute('src')) {
      source.remove()
    }
  }
}

// The old editor's resizable media, whose kind agrees with its tag and whose layout is under its own names
const UNNAMED = ':not([data-align]):not([data-float])'
const OLD_MEDIA = `img[media-type="img"]${UNNAMED}, video[media-type="video"]${UNNAMED}`

// Old resizable media laid out as the old editor showed it, under the names the editor reads; its
// kind goes, since the tag says it, so a disagreeing kind, a layout under both names or a layout
// the old editor never wrote fails the check
function mapOldMedia(body: HTMLElement) {
  const olds = [...body.querySelectorAll(OLD_MEDIA)].filter((old) =>
    isOldLayout(old.getAttribute('dataalign'), old.getAttribute('datafloat')),
  )
  for (const old of olds) {
    const { align, float } = oldLayout(old.getAttribute('dataalign'), old.getAttribute('datafloat'))
    old.setAttribute('data-align', align)
    if (float) {
      old.setAttribute('data-float', float)
    }

    for (const name of ['media-type', 'dataalign', 'datafloat']) {
      old.removeAttribute(name)
    }
  }

  return olds.length > 0
}

// The old editor showed old media's alignment over its float, so a float beside one goes
function droppedHtmlFloats(body: HTMLElement) {
  const olds = [...body.querySelectorAll(OLD_MEDIA)]
  if (!olds.some((old) => old.hasAttribute('dataalign') && old.hasAttribute('datafloat'))) {
    return []
  }

  return ['datafloat']
}

// The HTML the editor reads, its old media mapped and see-through colours cleared in place;
// written back from the parse only when that, moving a span's background or naming an old Drive
// highlight changed it. Text goes first, so a mark whose text colour is see-through can unwrap
function readableHtml(body: HTMLElement, html: string) {
  const isCleared = [clearSeeThroughText(body), clearSeeThroughHighlights(body)].includes(true)
  const isMapped = mapOldMedia(body)
  const readable = body.cloneNode(true) as HTMLElement
  const isMoved = moveSpanHighlights(readable)
  if (!nameOldDriveHighlights(readable) && !isMoved && !isMapped && !isCleared) {
    return html
  }

  return readable.innerHTML
}

// frappe-ui wrote its upload marks on media but forced them to null when reading HTML, so no
// reader drew them
const UPLOAD_MARKS = ['uploadid', 'error']

function dropUploadMarks(body: HTMLElement) {
  const media = [...body.querySelectorAll('img, video')]
  const names = UPLOAD_MARKS.filter((name) => media.some((element) => element.hasAttribute(name)))
  for (const element of media) {
    for (const name of names) {
      element.removeAttribute(name)
    }
  }

  return names
}

// The fresh body as the editor draws it
function drawn(fresh: XmlFragment) {
  const { content } = yXmlFragmentToProseMirrorRootNode(fresh, schema)
  return DOMSerializer.fromSchema(schema).serializeFragment(content)
}

// A noise attribute is dropped when a value the old HTML holds isn't drawn
function valuesOf(root: ParentNode, name: string) {
  return [...root.querySelectorAll(`[${name}]`)].map((element) => element.getAttribute(name))
}

function droppedNoise(source: ParentNode, result: ParentNode) {
  return NOISE_ATTRIBUTES.filter((name) => {
    const drawnValues = new Set(valuesOf(result, name))
    return valuesOf(source, name).some((value) => !drawnValues.has(value))
  })
}

// The check compares the old HTML, its old media mapped, its see-through colours cleared and a
// float beside an alignment dropped (recorded), frappe-ui's upload marks dropped (recorded) and
// Drive's defaults dropped, with the fresh body as the editor draws it; every property the raw
// style text names must survive the parse, bar the noise list, and the whitespace the parser
// folds isn't compared
function fromHtml(html: string) {
  const { body } = new DOMParser().parseFromString(html, 'text/html')
  const hasUnreadableThreads = !!body.querySelector(OLD_THREAD_TAGS)
  // Before the defaults go, since dropping one rewrites the style text from the parse
  const raw = rawStyles(body)
  const floats = droppedHtmlFloats(body)
  const node = schema.nodeFromJSON(generateJSON(readableHtml(body, html), extensions))
  const uploadMarks = dropUploadMarks(body)
  dropDriveHtmlDefaults(body)
  const source = domInventory(body, atomNameOf)
  return {
    node,
    dropped: [] as Dropped[],
    hasUnreadableThreads,
    check: (fresh: XmlFragment): Dropped[] | null => {
      const result = drawn(fresh)
      if (!raw.isKept || unkept(source, domInventory(result, atomNameOf)).length) {
        return null
      }

      const names = [...raw.noise, ...uploadMarks, ...floats, ...droppedNoise(body, result)]
      return names.map((name): Dropped => ({ kind: 'noise', name }))
    },
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

function read(choice: Exclude<LegacyRead, { case: 'unreadable-yjs' }>) {
  if (choice.case === 'yjs') {
    return { ...fromYjs(choice.old), from: 'yjs' as const }
  }

  if (choice.case === 'empty-yjs') {
    return { ...fromHtmlOverYjs(choice.old, choice.html), from: 'html' as const }
  }

  return { ...fromHtml(choice.html), from: 'html' as const }
}

function checkedBody(choice: Exclude<LegacyRead, { case: 'unreadable-yjs' }>) {
  const { node, dropped, hasUnreadableThreads, check, from } = read(choice)
  if (hasUnreadableThreads) {
    return null
  }

  const converted = withHeadingIds(node)
  const fresh = new Doc()
  const body = fresh.getXmlFragment(BODY_FIELD)
  prosemirrorToYXmlFragment(converted, body)
  const noise = check(body)
  if (!noise || breaksStyle(body)) {
    return null
  }

  const comments = moveComments(body)
  if (!comments.isMoved) {
    return null
  }

  return {
    fresh,
    from,
    anchors: comments.anchors,
    dropped: [...dropped, ...noise, ...comments.dropped],
  }
}

/** The old document as a fresh collaborative body, checked to hold the old text, formatting and parts apart from what it drops. */
export function convertLegacy(legacy: LegacyBody, maxState: number): Converted {
  let checked: ReturnType<typeof checkedBody>
  try {
    const choice = readLegacy(legacy)
    if (choice.case === 'unreadable-yjs') {
      return { kind: 'failed', reason: choice.case }
    }

    checked = checkedBody(choice)
  } catch {
    checked = null
  }

  if (!checked) {
    return { kind: 'failed', reason: 'check' }
  }

  const state = encodeStateAsUpdate(checked.fresh)
  if (state.byteLength > maxState) {
    return { kind: 'failed', reason: 'too_large' }
  }

  const { dropped, from, anchors } = checked
  return { kind: 'converted', state, dropped, from, anchors }
}
