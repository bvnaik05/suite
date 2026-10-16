/**
 * Find the quoted reply trail(s) in a rendered message so the reader can collapse them.
 *
 * Every client marks its trail differently. Gmail, Yahoo, Proton, Zoho and our own composer wrap
 * it in a classed container. Apple Mail and Thunderbird use `<blockquote type="cite">`,
 * Thunderbird with a classed attribution line as the sibling just before it. Outlook on the web
 * wraps nothing: it drops a From/Sent/To/Subject header into the flow and the original message
 * simply follows as its siblings. It also rewrites every class and id in content it quotes with
 * an `x_` prefix (gmail_quote → x_gmail_quote), so a Gmail reply that passed through Outlook only
 * ever arrives prefixed.
 *
 * `findQuoteRoots` normalises all of that into a list of outermost elements, one per trail.
 * Sibling-run trails (Outlook, Thunderbird with its attribution line) are wrapped in a fresh
 * `<div>` first so each trail is a single node the caller can hide and toggle.
 *
 * Not every block in that markup is history the reader has already seen. A forward travels in
 * the same containers, and it is the message. A writer who answers inline types between the
 * quoted lines, inside the trail. And a mail can be nothing but a quote. Each of those stays on
 * view, or the reader opens a reply and finds it blank above a "Show trimmed content" button.
 *
 * The backend's `preview_from_html` strips every trail it finds, forwards and inline answers
 * included, so the preview may say less than the reader shows but never shows what it hides.
 */

const QUOTE_CLASS =
  /^(?:x_)?(?:gmail_quote|frappe_mail_quote|yahoo_quoted|protonmail_quote|zmail_extra)$/
// Thunderbird's "On … wrote:" line, a sibling just before its <blockquote type="cite">.
const CITE_PREFIX_CLASS = /^(?:x_)?moz-cite-prefix$/
// Outlook on the web: an empty marker, then the header the original message follows.
const OUTLOOK_MARKER_ID = /^(?:x_)?appendonsend$/
const OUTLOOK_WEB_HEADER_ID = /^(?:x_)?divRplyFwdMsg$/
// Gmail's reply and ours quote the original in a <blockquote> right under the container; around a
// forward the same containers hold the message itself. Read from the markup, so it holds in every
// language Gmail writes its "Forwarded message" line in.
const QUOTING_CONTAINER_CLASS = /^(?:x_)?(?:gmail_quote|frappe_mail_quote)$/
// The line a forward opens with: Gmail's and Proton's "Forwarded message", Apple Mail's "Begin
// forwarded message:".
const FORWARD_LINE = /forwarded message/i

const hasClass = (el: Element, pattern: RegExp) =>
  Array.from(el.classList).some((c) => pattern.test(c))

// Wrap `first` and every sibling after it in one <div>, returning the wrapper.
const wrapTrail = (first: Node) => {
  const wrapper = first.ownerDocument!.createElement('div')
  first.parentNode!.insertBefore(wrapper, first)
  while (wrapper.nextSibling) wrapper.appendChild(wrapper.nextSibling)
  return wrapper
}

// Wrap `nodes` (contiguous siblings, in order) in one <div>, returning the wrapper.
const wrapRun = (nodes: Node[]) => {
  const wrapper = nodes[0].ownerDocument!.createElement('div')
  nodes[0].parentNode!.insertBefore(wrapper, nodes[0])
  nodes.forEach((n) => wrapper.appendChild(n))
  return wrapper
}

// Outlook's trail starts at the marker/rule just before its header when they're present.
const outlookTrailStart = (header: Element) => {
  let start: Element = header
  for (let prev = start.previousElementSibling; prev; prev = prev.previousElementSibling) {
    if (prev.tagName !== 'HR' && !OUTLOOK_MARKER_ID.test(prev.id)) break
    start = prev
  }
  return start
}

// Thunderbird's attribution line before a cite blockquote, when there is one.
const attributionBefore = (quote: Element) => {
  const prev = quote.previousElementSibling
  return prev && hasClass(prev, CITE_PREFIX_CLASS) ? prev : null
}

// The first line of a trail: its first child that holds anything.
const firstLine = (trail: Element) => {
  for (const node of Array.from(trail.childNodes)) {
    if (node.nodeName === 'BR' || !node.textContent?.trim()) continue
    return node.textContent
  }
  return ''
}

// The line above a cite blockquote, where iPhone Mail puts "Begin forwarded message:".
const lineBefore = (quote: Element) => {
  let prev = quote.previousElementSibling
  while (prev?.tagName === 'BR') prev = prev.previousElementSibling
  return prev?.textContent ?? ''
}

const isForward = (trail: Element) =>
  FORWARD_LINE.test(firstLine(trail)) ||
  (trail.tagName === 'BLOCKQUOTE' && FORWARD_LINE.test(lineBefore(trail))) ||
  (trail.tagName !== 'BLOCKQUOTE' &&
    hasClass(trail, QUOTING_CONTAINER_CLASS) &&
    !trail.querySelector(':scope > blockquote'))

// Text a reader would see: not the stylesheet a mail carries in its body.
const textNodes = (root: Node) => {
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('style, script, title') || !node.textContent?.trim()
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

export const findQuoteRoots = (root: ParentNode): Element[] => {
  const candidates = new Set<Element>()

  root.querySelectorAll('[class]').forEach((el) => {
    if (hasClass(el, QUOTE_CLASS)) candidates.add(el)
  })

  root.querySelectorAll('[id]').forEach((el) => {
    if (OUTLOOK_WEB_HEADER_ID.test(el.id)) candidates.add(wrapTrail(outlookTrailStart(el)))
  })

  root.querySelectorAll('blockquote[type]').forEach((el) => {
    if (el.getAttribute('type')?.toLowerCase() !== 'cite') return
    const attribution = attributionBefore(el)
    candidates.add(attribution ? wrapRun([attribution, el]) : el)
  })

  // The trails directly inside `within` (or the whole message): hiding one hides whatever is
  // quoted inside it.
  const outermost = (within?: Element) =>
    Array.from(candidates).filter((el) => {
      if (el === within || (within && !within.contains(el))) return false
      for (let p = el.parentElement; p && p !== within; p = p.parentElement)
        if (candidates.has(p)) return false
      return true
    })

  // What the writer typed inside a trail, around the lines they quote.
  const isQuoted = (node: Node, trail: Element) => {
    for (let p = node.parentElement; p && p !== trail; p = p.parentElement)
      if (p.tagName === 'BLOCKQUOTE' || candidates.has(p)) return true
    return false
  }
  const hasWriterTextAfter = (trail: Element, quote: Element) =>
    textNodes(trail).some(
      (node) =>
        !quote.contains(node) &&
        quote.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING &&
        !isQuoted(node, trail),
    )
  // Only a container can hold an answer: everything inside a quoted blockquote is the quoted
  // author's, their own inline answers included, and Outlook's trail is quoted as a whole.
  const firstQuote = (trail: Element) =>
    trail.tagName !== 'BLOCKQUOTE' && hasClass(trail, QUOTE_CLASS)
      ? Array.from(trail.querySelectorAll('*')).find(
          (el) => el.tagName === 'BLOCKQUOTE' || candidates.has(el),
        )
      : undefined

  // A forward stays, and so does a trail the writer answered inside — of those, only history
  // with nothing of theirs after it folds away.
  const trailsIn = (trail: Element): Element[] => {
    if (isForward(trail)) return outermost(trail).flatMap(trailsIn)
    const quote = firstQuote(trail)
    if (quote && hasWriterTextAfter(trail, quote))
      return outermost(trail)
        .filter((inner) => !hasWriterTextAfter(trail, inner))
        .flatMap(trailsIn)
    return [trail]
  }

  const trails = outermost().flatMap(trailsIn)

  // A mail that is nothing but a quote is shown as it is — there is nothing else to read.
  const hidden = (node: Node) => trails.some((trail) => trail.contains(node))
  return textNodes(root as Node).some((node) => !hidden(node)) ? trails : []
}
