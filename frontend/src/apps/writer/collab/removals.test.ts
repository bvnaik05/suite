import { ADOPT, APPLIED_UPDATE, REMOTE, type CollabRoom } from '@suite/collab-client'
import {
  device,
  fakeLocks,
  fakeServer,
  fakeTime,
  idle,
  join,
  offlinePushes,
  type FakeServer,
} from '@suite/collab-client/test-support'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { BODY_FIELD } from '@/apps/writer/collab/field'
import { findRemovals, typeBack, watchRemovals, type Removal } from '@/apps/writer/collab/removals'
import {
  blocks,
  deliver,
  inside,
  openTabs,
  sendRow,
  stored,
  syncAll,
  type Tab,
} from '@/apps/writer/collab/test-support'

vi.mock('@/apps/writer/utils', () => ({ insertTemplate: () => {} }))
vi.mock('@/apps/writer/resources', () => ({ getTemplates: {} }))

function paragraph(...content: object[]) {
  return { type: 'paragraph', content }
}

function text(value: string) {
  return { type: 'text', text: value }
}

const threeParagraphs = stored(
  paragraph(text('abc')),
  paragraph(text('defgh')),
  paragraph(text('xyz')),
)

function makeHeading(tab: Tab, word: string) {
  tab.editor.chain().setTextSelection(inside(tab, word)).setNode('heading', { level: 2 }).run()
}

function joinUp(tab: Tab, word: string) {
  tab.editor
    .chain()
    .setTextSelection(inside(tab, word, 0))
    .joinBackward()
    .run()
}

function typeAt(tab: Tab, word: string, offset: number, content: string | object) {
  tab.editor
    .chain()
    .setTextSelection(inside(tab, word, offset))
    .insertContent(content)
    .run()
}

function typeQQ(tab: Tab, word: string) {
  tab.editor
    .chain()
    .setTextSelection(inside(tab, word, 2))
    .insertContent('QQ')
    .run()
}

function deleteBlock(tab: Tab, index: number) {
  const { doc } = tab.editor.state
  let from = 0
  for (let child = 0; child < index; child++) {
    from += doc.child(child).nodeSize
  }

  tab.editor.commands.deleteRange({ from, to: from + doc.child(index).nodeSize })
}

function allReported(tabs: Tab[]) {
  return tabs.flatMap((tab) => tab.reported)
}

async function sendInOrder(tabs: Tab[], senders: Tab[]) {
  await deliver(
    tabs,
    senders.map((sender) => [sender, sendRow(sender)]),
  )
  await syncAll(tabs)
}

const lostQQ = {
  kind: 'text',
  seen: 'defgh',
  runs: [{ offset: 2, text: 'QQ', attrs: {} }],
  written: expect.anything(),
  pulled: expect.anything(),
  isUncertain: false,
}

// Text of mine yjs never kept, because it was written into a block already gone
function neverKept(lost: string) {
  return {
    kind: 'text',
    seen: '',
    runs: [{ offset: 0, text: lost, attrs: {} }],
    written: expect.anything(),
    pulled: expect.anything(),
    isUncertain: false,
    key: expect.any(String),
  }
}

function mention() {
  const element = new Y.XmlElement('mention')
  element.setAttribute('id', 'someone')
  return element
}

function docOf(update: Uint8Array) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  return doc
}

function oldBlockText(doc: Y.Doc) {
  const block = doc.getXmlFragment(BODY_FIELD).get(1) as Y.XmlElement
  return block.get(0) as Y.XmlText
}

function removeOldBlock(doc: Y.Doc) {
  const body = doc.getXmlFragment(BODY_FIELD)
  doc.transact(() => {
    body.delete(1, 1)
    body.insert(1, [new Y.XmlElement('heading')])
  })
}

// Applies `updates` to `doc` as one pulled transaction and returns what it removed of `writer`'s
function removalsOnApply(doc: Y.Doc, updates: Uint8Array[], writer: Y.Doc, origin = REMOTE) {
  const found: Removal[] = []
  doc.on('afterTransaction', (transaction: Y.Transaction) => {
    found.push(...findRemovals(transaction, updates, new Set([writer.clientID])))
  })
  doc.transact(() => Y.applyUpdate(doc, Y.mergeUpdates(updates)), origin)
  return found
}

// Turns the room's second block into a heading reading `words`, in one edit
function makeRoomHeading(room: CollabRoom, words: string) {
  const body = room.doc.getXmlFragment(BODY_FIELD)
  const heading = new Y.XmlElement('heading')
  heading.setAttribute('level', '2')
  heading.insert(0, [new Y.XmlText(words)])
  room.doc.transact(() => {
    body.delete(1, 1)
    body.insert(1, [heading])
  })
}

function roomText(room: CollabRoom, index: number) {
  const block = room.doc.getXmlFragment(BODY_FIELD).get(index) as Y.XmlElement
  return block.get(0) as Y.XmlText
}

// Real rooms on one device: a tab whose pushes fail turns defgh into a heading reading `heading`,
// this tab types QQ into the old block, `beforeClose` runs, then the other tab closes and this one takes its work on
async function takeOverHeading(heading: string, beforeClose = async (_server: FakeServer) => {}) {
  fakeTime()
  const server = fakeServer()
  const first = await join(server.endpoints())
  Y.applyUpdate(first.doc, threeParagraphs)
  await first.flush()
  const kept = await device()
  const typing = await join(server.endpoints(), { device: kept })
  const closing = await join(offlinePushes(server), { device: kept })
  const reported: Removal[] = []
  watchRemovals(typing, (removals) => reported.push(...removals))

  makeRoomHeading(closing, heading)
  await vi.advanceTimersByTimeAsync(0)
  await idle()
  roomText(typing, 1).insert(2, 'QQ')
  await beforeClose(server)
  await closing.close()
  await vi.advanceTimersByTimeAsync(60_000)
  await idle()
  return { first, typing, reported }
}

function roomBlocks(room: CollabRoom) {
  const body = room.doc.getXmlFragment(BODY_FIELD).toArray() as Y.XmlElement[]
  return body.map((block) => {
    const words = block.get(0).toString()
    return `${block.nodeName} ${words}`
  })
}

describe('text a row removed with the block around it', () => {
  it('types the joined text back when the other tab made the block a heading (R154.1)', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [headingTab, joinTab] = tabs
    makeHeading(headingTab, 'abc')
    joinUp(joinTab, 'defgh')

    await sendInOrder(tabs, tabs)

    expect(blocks(headingTab)).toEqual(['heading abcdefgh', 'paragraph xyz'])
    expect(blocks(joinTab)).toEqual(blocks(headingTab))
    expect(allReported(tabs)).toEqual([])
  })

  it('types text back once when the other tab made its block a heading (R154.2)', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [headingTab, typingTab] = tabs
    makeHeading(headingTab, 'defgh')
    typeQQ(typingTab, 'defgh')

    await sendInOrder(tabs, tabs)

    expect(blocks(headingTab)).toEqual(['paragraph abc', 'heading deQQfgh', 'paragraph xyz'])
    expect(blocks(typingTab)).toEqual(blocks(headingTab))
    expect(allReported(tabs)).toEqual([])
  })

  it('types back two tabs typing at different places when a third made the block a heading (R296)', async () => {
    const tabs = await openTabs(threeParagraphs, 3)
    const [headingTab, qqTab, rrTab] = tabs
    typeQQ(qqTab, 'defgh')
    typeAt(rrTab, 'defgh', 4, 'RR')
    makeHeading(headingTab, 'defgh')

    await sendInOrder(tabs, [qqTab, rrTab, headingTab])

    for (const tab of tabs) {
      expect(blocks(tab)).toEqual(['paragraph abc', 'heading deQQfgRRh', 'paragraph xyz'])
    }

    expect(allReported(tabs)).toEqual([])
  })

  it('types back into the row copy, not an older block with the same text', async () => {
    const repeated = stored(
      paragraph(text('abc')),
      paragraph(text('defgh')),
      paragraph(text('defgh')),
    )
    const tabs = await openTabs(repeated, 2)
    const [joinTab, typingTab] = tabs
    joinUp(joinTab, 'defgh')
    typeQQ(typingTab, 'defgh')

    await sendInOrder(tabs, tabs)

    expect(blocks(joinTab)).toEqual(['paragraph abcdeQQfgh', 'paragraph defgh'])
    expect(blocks(typingTab)).toEqual(blocks(joinTab))
    expect(allReported(tabs)).toEqual([])
  })

  it('reports text the row copied to two places, and types neither back', async () => {
    const twice = stored(paragraph(text('defgh')), paragraph(text('defgh')), paragraph(text('xyz')))
    const tabs = await openTabs(twice, 2)
    const [headingTab, typingTab] = tabs
    const to = headingTab.editor.state.doc.child(0).nodeSize + 2
    headingTab.editor
      .chain()
      .setTextSelection({ from: 1, to })
      .setNode('heading', { level: 2 })
      .run()
    typeQQ(typingTab, 'defgh')

    await sendInOrder(tabs, tabs)

    expect(blocks(headingTab)).toEqual(['heading defgh', 'heading defgh', 'paragraph xyz'])
    expect(blocks(typingTab)).toEqual(blocks(headingTab))
    expect(typingTab.reported).toEqual([lostQQ])
    expect(headingTab.reported).toEqual([])
  })

  it('types back when the same row also typed in another block', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [headingTab, typingTab] = tabs
    makeHeading(headingTab, 'defgh')
    typeAt(headingTab, 'xyz', 3, 'more')
    typeQQ(typingTab, 'defgh')

    await sendInOrder(tabs, tabs)

    expect(blocks(headingTab)).toEqual(['paragraph abc', 'heading deQQfgh', 'paragraph xyzmore'])
    expect(blocks(typingTab)).toEqual(blocks(headingTab))
    expect(allReported(tabs)).toEqual([])
  })
})

// The editor adds an empty paragraph after a last block that stops being one, in the same step
describe('text typed into a block as another tab restructures it (R291)', () => {
  const abcAtEnd = stored(paragraph(text('one')), paragraph(text('abc')))

  const orders = [
    {
      name: 'A is tab 1, A sends first',
      isRestructurerFirstTab: true,
      isRestructurerSendingFirst: true,
    },
    {
      name: 'A is tab 1, B sends first',
      isRestructurerFirstTab: true,
      isRestructurerSendingFirst: false,
    },
    {
      name: 'A is tab 2, A sends first',
      isRestructurerFirstTab: false,
      isRestructurerSendingFirst: true,
    },
    {
      name: 'A is tab 2, B sends first',
      isRestructurerFirstTab: false,
      isRestructurerSendingFirst: false,
    },
  ]

  type Order = (typeof orders)[number]

  function typeWithRule(tab: Tab, word: string, marker: string) {
    tab.editor
      .chain()
      .setTextSelection(inside(tab, word, 0))
      .insertContent(marker)
      .run()
    const { view } = tab.editor
    const { from, to } = view.state.selection
    view.someProp('handleTextInput', (handle) =>
      handle(view, from, to, ' ', () => view.state.tr.insertText(' ', from, to)),
    )
  }

  function lostX(seen: string, offset: number) {
    return {
      kind: 'text',
      seen,
      runs: [{ offset, text: 'X', attrs: {} }],
      written: expect.anything(),
      pulled: expect.anything(),
      isUncertain: false,
    }
  }

  function topTypes(tab: Tab) {
    return tab.editor.getJSON().content!.map((node) => node.type)
  }

  // A restructures a block while B types in it, by default X between b and c of the last block "abc"
  async function restructureWhileTyping(
    order: Order,
    restructure: (tab: Tab) => void,
    state = abcAtEnd,
    typeInBlock = (tab: Tab) => typeAt(tab, 'abc', 2, 'X'),
  ) {
    const tabs = await openTabs(state, 2)
    const [first, second] = tabs
    const restructuring = order.isRestructurerFirstTab ? first : second
    const typing = order.isRestructurerFirstTab ? second : first
    restructure(restructuring)
    typeInBlock(typing)

    const senders = [restructuring, typing]
    if (!order.isRestructurerSendingFirst) {
      senders.reverse()
    }

    await sendInOrder(tabs, senders)
    return tabs
  }

  function lastBlockAt(tab: Tab, offset: number) {
    const { doc } = tab.editor.state
    return doc.content.size - doc.lastChild!.nodeSize + 1 + offset
  }

  it.each(orders)('types it back into the heading made with the menu ($name)', async (order) => {
    const tabs = await restructureWhileTyping(order, (tab) => makeHeading(tab, 'abc'))

    for (const tab of tabs) {
      expect(blocks(tab)).toEqual(['paragraph one', 'heading abXc', 'paragraph '])
    }

    expect(allReported(tabs)).toEqual([])
  })

  // The rule's row wrote the marker and removed it with the block, so the copy lacks what the typing tab saw
  it.each(orders)('reports it when the heading was made by typing ## ($name)', async (order) => {
    const tabs = await restructureWhileTyping(order, (tab) => typeWithRule(tab, 'abc', '##'))

    for (const tab of tabs) {
      expect(blocks(tab)).toEqual(['paragraph one', 'heading abc', 'paragraph '])
    }

    expect(allReported(tabs)).toEqual([lostX('##abc', 4)])
  })

  it.each(orders)('types it back into the list made with the menu ($name)', async (order) => {
    const tabs = await restructureWhileTyping(order, (tab) =>
      tab.editor.chain().setTextSelection(inside(tab, 'abc')).toggleBulletList().run(),
    )

    for (const tab of tabs) {
      expect(topTypes(tab)).toEqual(['paragraph', 'bulletList', 'paragraph'])
      expect(blocks(tab)).toEqual(['paragraph one', 'paragraph abXc', 'paragraph '])
    }

    expect(allReported(tabs)).toEqual([])
  })

  it.each(orders)('reports it when the list was made by typing - ($name)', async (order) => {
    const tabs = await restructureWhileTyping(order, (tab) => typeWithRule(tab, 'abc', '-'))

    for (const tab of tabs) {
      expect(topTypes(tab)).toEqual(['paragraph', 'bulletList', 'paragraph'])
      expect(blocks(tab)).toEqual(['paragraph one', 'paragraph abc', 'paragraph '])
    }

    expect(allReported(tabs)).toEqual([lostX('-abc', 3)])
  })

  it.each(orders)(
    'keeps it in the empty last paragraph a table went into ($name)',
    async (order) => {
      const emptyAtEnd = stored(paragraph(text('one')), { type: 'paragraph' })
      const tabs = await restructureWhileTyping(
        order,
        (tab) =>
          tab.editor
            .chain()
            .setTextSelection(lastBlockAt(tab, 0))
            .insertTable({ rows: 1, cols: 1, withHeaderRow: false })
            .run(),
        emptyAtEnd,
        (tab) => tab.editor.chain().setTextSelection(lastBlockAt(tab, 0)).insertContent('X').run(),
      )

      for (const tab of tabs) {
        expect(topTypes(tab)).toEqual(['paragraph', 'table', 'paragraph'])
        expect(blocks(tab).at(-1)).toEqual('paragraph X')
      }

      expect(allReported(tabs)).toEqual([])
    },
  )

  it.each(orders)(
    'types it back into the heading made in the step that adds an empty paragraph above ($name)',
    async (order) => {
      const abcFirst = stored(paragraph(text('abc')), paragraph(text('xyz')))
      const tabs = await restructureWhileTyping(
        order,
        (tab) =>
          tab.editor
            .chain()
            .setTextSelection(inside(tab, 'abc'))
            .setNode('heading', { level: 2 })
            .insertContentAt(0, { type: 'paragraph' })
            .run(),
        abcFirst,
      )

      for (const tab of tabs) {
        expect(blocks(tab)).toEqual(['paragraph ', 'heading abXc', 'paragraph xyz'])
      }

      expect(allReported(tabs)).toEqual([])
    },
  )

  it.each(orders)(
    'keeps it in a short paragraph a table went in front of ($name)',
    async (order) => {
      const abAtEnd = stored(paragraph(text('one')), paragraph(text('ab')))
      const tabs = await restructureWhileTyping(
        order,
        (tab) =>
          tab.editor
            .chain()
            .setTextSelection(inside(tab, 'ab', 0))
            .insertTable({ rows: 1, cols: 1, withHeaderRow: false })
            .run(),
        abAtEnd,
        (tab) => typeAt(tab, 'ab', 1, 'X'),
      )

      for (const tab of tabs) {
        expect(topTypes(tab)).toEqual(['paragraph', 'table', 'paragraph'])
        expect(blocks(tab).at(-1)).toEqual('paragraph aXb')
      }

      expect(allReported(tabs)).toEqual([])
    },
  )

  // Pinned in R2 as 01.2 with QQ left on its own line after the heading
  it.each(orders)('types back a word typed at the end of the block ($name)', async (order) => {
    const limaAtEnd = stored(
      paragraph(text('alpha sentence alpha')),
      paragraph(text('lima sentence lima')),
    )
    const tabs = await restructureWhileTyping(
      order,
      (tab) => makeHeading(tab, 'lima'),
      limaAtEnd,
      (tab) => typeAt(tab, 'lima sentence lima', 18, 'QQ'),
    )

    for (const tab of tabs) {
      expect(blocks(tab)).toEqual([
        'paragraph alpha sentence alpha',
        'heading lima sentence limaQQ',
        'paragraph ',
      ])
    }

    expect(allReported(tabs)).toEqual([])
  })

  it.each(orders)('keeps it in a block emptied and split in one step ($name)', async (order) => {
    const abcdLast = stored(paragraph(text('one')), paragraph(text('abcd')))
    const tabs = await restructureWhileTyping(
      order,
      (tab) =>
        tab.editor
          .chain()
          .setTextSelection({ from: inside(tab, 'abcd', 0), to: inside(tab, 'abcd', 4) })
          .splitBlock()
          .run(),
      abcdLast,
      (tab) => typeAt(tab, 'abcd', 2, 'XY'),
    )

    for (const tab of tabs) {
      expect(blocks(tab)).toEqual(['paragraph one', 'paragraph XY', 'paragraph '])
    }

    expect(allReported(tabs)).toEqual([])
  })

  it.each(orders)(
    'keeps it in a block emptied in the step that edits the next one ($name)',
    async (order) => {
      const abcdMid = stored(
        paragraph(text('one')),
        paragraph(text('abcd')),
        paragraph(text('xyz')),
      )
      const tabs = await restructureWhileTyping(
        order,
        (tab) =>
          tab.editor
            .chain()
            .insertContentAt(inside(tab, 'xyz', 3), 'W')
            .deleteRange({ from: inside(tab, 'abcd', 0), to: inside(tab, 'abcd', 4) })
            .run(),
        abcdMid,
        (tab) => typeAt(tab, 'abcd', 2, 'XY'),
      )

      for (const tab of tabs) {
        expect(blocks(tab)).toEqual(['paragraph one', 'paragraph XY', 'paragraph xyzW'])
      }

      expect(allReported(tabs)).toEqual([])
    },
  )
})

// The row also typed inside the block it restructured, so no run it wrote equals `seen` there
describe('text the row could only type back in the wrong place (R278)', () => {
  it('reports when another run the row typed holds the text', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [headingTab, typingTab] = tabs
    makeHeading(headingTab, 'defgh')
    typeAt(headingTab, 'defgh', 2, 'X')
    typeAt(headingTab, 'xyz', 3, 'defghs')
    typeQQ(typingTab, 'defgh')

    await sendInOrder(tabs, tabs)

    expect(blocks(headingTab)).toEqual(['paragraph abc', 'heading deXfgh', 'paragraph xyzdefghs'])
    expect(blocks(typingTab)).toEqual(blocks(headingTab))
    expect(typingTab.reported).toEqual([lostQQ])
  })

  it('reports when the row typed the text in two places around older text (R305)', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [deletingTab, typingTab] = tabs
    deleteBlock(deletingTab, 1)
    typeAt(deletingTab, 'xyz', 0, 'de')
    typeAt(deletingTab, 'dexyz', 5, 'fgh')
    typeQQ(typingTab, 'defgh')

    await sendInOrder(tabs, tabs)

    expect(blocks(deletingTab)).toEqual(['paragraph abc', 'paragraph dexyzfgh'])
    expect(blocks(typingTab)).toEqual(blocks(deletingTab))
    expect(typingTab.reported).toEqual([lostQQ])
  })

  it('reports when the text is short, even where a whole run the row typed matches it', async () => {
    const tabs = await openTabs(stored(paragraph(text('ab')), paragraph(text('xyz'))), 2)
    const [headingTab, typingTab] = tabs
    makeHeading(headingTab, 'ab')
    typeAt(headingTab, 'ab', 1, 'X')
    typeAt(headingTab, 'xyz', 3, 'ab')
    typeQQ(typingTab, 'ab')

    await sendInOrder(tabs, tabs)

    expect(blocks(headingTab)).toEqual(['heading aXb', 'paragraph xyzab'])
    expect(blocks(typingTab)).toEqual(blocks(headingTab))
    const runs = [{ offset: 2, text: 'QQ', attrs: {} }]
    const lost = {
      kind: 'text',
      seen: 'ab',
      runs,
      written: expect.anything(),
      pulled: expect.anything(),
      isUncertain: false,
    }
    expect(typingTab.reported).toEqual([lost])
  })

  it('reports a removal with nothing seen without looking for a place (R279)', () => {
    const ydoc = new Y.Doc()
    const body = ydoc.getXmlFragment('body')
    const line = new Y.XmlText()
    body.insert(0, [line])
    line.insert(0, 'abc')
    const written = {
      before: new Map<number, number>(),
      after: Y.decodeStateVector(Y.encodeStateVector(ydoc)),
    }

    const removal = {
      kind: 'text' as const,
      seen: '',
      runs: [{ offset: 0, text: 'QQ', attrs: {} }],
      written,
      pulled: written,
      isUncertain: false,
    }
    expect(typeBack(body, removal)).toBe(false)
  })
})

// Each text node of block `index` with its mark names
function markedParts(tab: Tab, index: number) {
  const parts: [string, string[]][] = []
  const block = tab.editor.state.doc.child(index)
  for (let child = 0; child < block.childCount; child++) {
    const node = block.child(child)
    parts.push([node.text ?? '', node.marks.map((mark) => mark.type.name)])
  }

  return parts
}

describe('typed-back text keeps its own marks (R281)', () => {
  it('comes back bold between plain text', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [headingTab, typingTab] = tabs
    makeHeading(headingTab, 'defgh')
    typeAt(typingTab, 'defgh', 2, { type: 'text', text: 'QQ', marks: [{ type: 'bold' }] })

    await sendInOrder(tabs, tabs)

    expect(markedParts(headingTab, 1)).toEqual([
      ['de', []],
      ['QQ', ['bold']],
      ['fgh', []],
    ])
    expect(typingTab.editor.getJSON()).toEqual(headingTab.editor.getJSON())
    expect(allReported(tabs)).toEqual([])
  })

  it('comes back plain after bold text', async () => {
    const bold = { type: 'text', text: 'fgh', marks: [{ type: 'bold' }] }
    const base = stored(paragraph(text('abc')), paragraph(text('de'), bold), paragraph(text('xyz')))
    const tabs = await openTabs(base, 2)
    const [headingTab, typingTab] = tabs
    makeHeading(headingTab, 'fgh')
    typingTab.editor
      .chain()
      .setTextSelection(inside(typingTab, 'fgh', 1))
      .unsetBold()
      .insertContent('QQ')
      .run()

    await sendInOrder(tabs, tabs)

    expect(markedParts(headingTab, 1)).toEqual([
      ['de', []],
      ['f', ['bold']],
      ['QQ', []],
      ['gh', ['bold']],
    ])
    expect(typingTab.editor.getJSON()).toEqual(headingTab.editor.getJSON())
    expect(allReported(tabs)).toEqual([])
  })
})

// A makes block 1 a heading, B joins block 2 up into it, C types in block 2
describe('three tabs restructuring and typing at once', () => {
  async function threeTabs() {
    const tabs = await openTabs(threeParagraphs, 3)
    const [headingTab, joinTab, typingTab] = tabs
    makeHeading(headingTab, 'abc')
    joinUp(joinTab, 'defgh')
    typeQQ(typingTab, 'defgh')
    return tabs
  }

  it("reports C's typing when A's row lands before B's", async () => {
    const tabs = await threeTabs()
    const [headingTab, joinTab, typingTab] = tabs

    await sendInOrder(tabs, [headingTab, joinTab, typingTab])

    for (const tab of tabs) {
      expect(blocks(tab)).toEqual(['heading abcdefgh', 'paragraph xyz'])
    }

    expect(typingTab.reported).toEqual([lostQQ])
    expect([...headingTab.reported, ...joinTab.reported]).toEqual([])
  })

  it("reports C's typing when B's row lands before A's", async () => {
    const tabs = await threeTabs()
    const [headingTab, joinTab, typingTab] = tabs

    await sendInOrder(tabs, [joinTab, headingTab, typingTab])

    for (const tab of tabs) {
      expect(blocks(tab)).toEqual(['heading abcdefgh', 'paragraph xyz'])
    }

    const runs = [{ offset: 3, text: 'QQ', attrs: {} }]
    const uncertain = {
      kind: 'text',
      seen: 'abc',
      runs,
      written: expect.anything(),
      pulled: expect.anything(),
      isUncertain: true,
    }
    expect(typingTab.reported).toEqual([uncertain])
    expect([...headingTab.reported, ...joinTab.reported]).toEqual([])
  })
})

describe('removals that are not reported', () => {
  it('stays quiet when a tab deletes a block after seeing the text in it', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [deletingTab, typingTab] = tabs
    typeQQ(typingTab, 'defgh')
    await syncAll(tabs)
    deleteBlock(deletingTab, 1)

    await syncAll(tabs)

    expect(blocks(typingTab)).toEqual(['paragraph abc', 'paragraph xyz'])
    expect(allReported(tabs)).toEqual([])
  })

  it('stays quiet when two tabs set the same attributes and one value wins', async () => {
    const base = stored(
      { type: 'heading', attrs: { level: 1 }, content: [text('abc')] },
      paragraph(
        text('de'),
        { type: 'image', attrs: { src: '/files/x.png', width: 100, height: 50 } },
        { type: 'mention', attrs: { id: 'ann', label: 'Ann' } },
        text('fgh'),
      ),
    )
    const tabs = await openTabs(base, 2)
    function setAll(tab: Tab, level: number, width: number, label: string) {
      const image = positionOf(tab, 'image')
      const mention = positionOf(tab, 'mention')
      tab.editor
        .chain()
        .setTextSelection(inside(tab, 'abc'))
        .updateAttributes('heading', { level })
        .run()
      tab.editor.chain().setNodeSelection(image).updateAttributes('image', { width }).run()
      tab.editor.chain().setNodeSelection(mention).updateAttributes('mention', { label }).run()
    }

    setAll(tabs[0], 2, 200, 'Annie')
    setAll(tabs[1], 3, 300, 'Anna')

    await sendInOrder(tabs, tabs)

    expect(tabs[1].editor.getJSON()).toEqual(tabs[0].editor.getJSON())
    expect(allReported(tabs)).toEqual([])
  })
})

function positionOf(tab: Tab, name: string) {
  let found = -1
  tab.editor.state.doc.descendants((node, position) => {
    if (found < 0 && node.type.name === name) {
      found = position
    }

    return found < 0
  })
  return found
}

describe('removals that are reported', () => {
  it('reports text when the other tab deleted its block at the same time', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [deletingTab, typingTab] = tabs
    deleteBlock(deletingTab, 1)
    typeQQ(typingTab, 'defgh')

    await sendInOrder(tabs, tabs)

    expect(blocks(typingTab)).toEqual(['paragraph abc', 'paragraph xyz'])
    expect(typingTab.reported).toEqual([lostQQ])
    expect(deletingTab.reported).toEqual([])
  })

  const inlineNodes: [string, object][] = [
    ['hardBreak', { type: 'hardBreak' }],
    ['mention', { type: 'mention', attrs: { id: 'ann', label: 'Ann' } }],
    ['image', { type: 'image', attrs: { src: '/files/x.png', width: 100, height: 50 } }],
  ]

  it.each(inlineNodes)(
    'reports a %s the other tab removed by making its block a heading',
    async (name, node) => {
      const tabs = await openTabs(threeParagraphs, 2)
      const [headingTab, insertingTab] = tabs
      makeHeading(headingTab, 'defgh')
      insertingTab.editor
        .chain()
        .setTextSelection(inside(insertingTab, 'defgh', 2))
        .insertContent(node)
        .run()

      await sendInOrder(tabs, tabs)

      expect(blocks(headingTab)).toEqual(['paragraph abc', 'heading defgh', 'paragraph xyz'])
      expect(positionOf(headingTab, name)).toBe(-1)
      expect(insertingTab.reported).toContainEqual(expect.objectContaining({ kind: 'node', name }))
      expect(headingTab.reported).toEqual([])
    },
  )
})

describe('a room watching for removals', () => {
  it("types back the text a tab took on from a closed tab's outbox (R295)", async () => {
    const [headingTab, typingTab, closedTab] = await openTabs(threeParagraphs, 3)
    typeQQ(closedTab, 'defgh')
    Y.applyUpdate(typingTab.ydoc, sendRow(closedTab)!, 'adopt')
    typingTab.room.ownClients.add(closedTab.ydoc.clientID)
    makeHeading(headingTab, 'defgh')
    const tabs = [headingTab, typingTab]

    await sendInOrder(tabs, tabs)

    for (const tab of tabs) {
      expect(blocks(tab)).toEqual(['paragraph abc', 'heading deQQfgh', 'paragraph xyz'])
    }

    expect(allReported(tabs)).toEqual([])
  })

  it("types back what a closed tab's restructure removed once this tab takes it on (R298)", async () => {
    fakeLocks()
    try {
      const { typing, reported } = await takeOverHeading('defgh')

      expect(roomBlocks(typing)).toEqual(['paragraph abc', 'heading deQQfgh', 'paragraph xyz'])
      expect(reported).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("reports what a closed tab's restructure removed when this tab takes it on and can't place it (R298)", async () => {
    fakeLocks()
    try {
      const { typing, reported } = await takeOverHeading('defghX')

      expect(roomBlocks(typing)).toEqual(['paragraph abc', 'heading defghX', 'paragraph xyz'])
      expect(reported).toEqual([lostQQ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // A tab types into defgh and closes without sending it, another makes the block a heading and sends it,
  // then a tab opens on the same device, with or without the network, watched before it applies anything
  async function reopenAfterRestructure(
    isOnline: boolean,
    typeOffline = (old: Y.XmlText) => old.insert(2, 'QQ'),
  ) {
    fakeTime()
    const server = fakeServer()
    const first = await join(server.endpoints())
    Y.applyUpdate(first.doc, threeParagraphs)
    await first.flush()
    const kept = await device()
    const closing = await join(offlinePushes(server), { device: kept })
    typeOffline(roomText(closing, 1))
    await vi.advanceTimersByTimeAsync(0)
    await idle()
    await closing.close()
    makeRoomHeading(first, 'defgh')
    await first.flush()
    server.access.online = isOnline
    const reported: Removal[] = []
    const reopened = await join(server.endpoints(), {
      device: kept,
      pollMs: 1000,
      watch: (room) => {
        watchRemovals(room, (removals) => reported.push(...removals))
      },
    })
    server.access.online = true
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await idle()
    await reopened.flush()
    await first.pull()
    return { rooms: [first, reopened], reported }
  }

  it('types back what a restructure removed from the work a tab opened offline took on, once it claims (R299)', async () => {
    fakeLocks()
    try {
      const { rooms, reported } = await reopenAfterRestructure(false)

      for (const room of rooms) {
        expect(roomBlocks(room)).toEqual(['paragraph abc', 'heading deQQfgh', 'paragraph xyz'])
      }

      expect(reported).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports what a restructure removed from the work a tab takes on as it opens (R308)', async () => {
    fakeLocks()
    try {
      const { rooms, reported } = await reopenAfterRestructure(true)

      for (const room of rooms) {
        expect(roomBlocks(room)).toEqual(['paragraph abc', 'heading defgh', 'paragraph xyz'])
      }

      expect(reported).toEqual([neverKept('QQ')])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports nothing of what the closed tab typed and deleted itself as a tab takes it on (R308)', async () => {
    fakeLocks()
    try {
      const { rooms, reported } = await reopenAfterRestructure(true, (old) => {
        old.insert(2, 'QQ')
        old.delete(2, 2)
      })

      expect([roomBlocks(rooms[1]), reported]).toEqual([
        ['paragraph abc', 'heading defgh', 'paragraph xyz'],
        [],
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports only what the closed tab typed and kept as a tab takes it on (R308)', async () => {
    fakeLocks()
    try {
      const { reported } = await reopenAfterRestructure(true, (old) => {
        old.insert(2, 'QQRR')
        old.delete(2, 2)
      })

      expect(reported).toEqual([neverKept('RR')])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports bold text the closed tab typed as bold as a tab takes it on (R308)', async () => {
    fakeLocks()
    try {
      const { reported } = await reopenAfterRestructure(true, (old) =>
        old.insert(2, 'QQ', { bold: {} }),
      )

      expect(reported).toEqual([
        { ...neverKept('QQ'), runs: [{ offset: 0, text: 'QQ', attrs: { bold: {} } }] },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a mention the closed tab added as one lost node as a tab takes it on (R308)', async () => {
    fakeLocks()
    try {
      const { reported } = await reopenAfterRestructure(true, (old) =>
        (old.parent as Y.XmlElement).insert(1, [mention()]),
      )

      expect(reported).toEqual([
        { kind: 'node', name: 'mention', attrs: {}, key: expect.any(String) },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("reports a closed tab's typing a tab takes on after it pulled the restructure (R308)", async () => {
    fakeLocks()
    fakeTime()
    try {
      const server = fakeServer()
      const first = await join(server.endpoints())
      Y.applyUpdate(first.doc, threeParagraphs)
      await first.flush()
      const kept = await device()
      const typing = await join(server.endpoints(), { device: kept })
      const closing = await join(offlinePushes(server), { device: kept })
      const reported: Removal[] = []
      watchRemovals(typing, (removals) => reported.push(...removals))
      roomText(closing, 1).insert(2, 'QQ')
      await vi.advanceTimersByTimeAsync(0)
      await idle()

      makeRoomHeading(first, 'defgh')
      await first.flush()
      await typing.pull()
      await closing.close()
      await vi.advanceTimersByTimeAsync(60_000)
      await idle()

      expect([roomBlocks(typing), reported]).toEqual([
        ['paragraph abc', 'heading defgh', 'paragraph xyz'],
        [neverKept('QQ')],
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("doesn't report another tab's text or mention written into a block already gone (R308)", async () => {
    fakeTime()
    const server = fakeServer()
    const first = await join(server.endpoints())
    Y.applyUpdate(first.doc, threeParagraphs)
    await first.flush()
    const typing = await join(server.endpoints())
    const other = await join(server.endpoints())
    const reported: Removal[] = []
    watchRemovals(typing, (removals) => reported.push(...removals))

    makeRoomHeading(first, 'defgh')
    await first.flush()
    await typing.pull()
    roomText(other, 1).insert(2, 'ZZ')
    ;(roomText(other, 1).parent as Y.XmlElement).insert(1, [mention()])
    await other.flush()
    await typing.pull()

    expect([roomBlocks(typing), reported]).toEqual([
      ['paragraph abc', 'heading defgh', 'paragraph xyz'],
      [],
    ])
  })

  it('reports only the part of an update of mine the doc never held before it was gone (R308)', () => {
    const writer = docOf(threeParagraphs)
    const reader = docOf(threeParagraphs)
    const base = Y.encodeStateVector(writer)
    oldBlockText(writer).insert(2, 'QQ')
    const typedQQ = Y.encodeStateAsUpdate(writer, base)
    oldBlockText(writer).insert(4, 'RR')
    const typedBoth = Y.encodeStateAsUpdate(writer, base)
    Y.applyUpdate(reader, typedQQ)
    removeOldBlock(reader)

    const found = removalsOnApply(reader, [typedBoth], writer)

    expect(found).toEqual([neverKept('RR')])
  })

  it("reports only my text of one apply that also wrote another's into a block already gone (R308)", () => {
    const writer = docOf(threeParagraphs)
    const other = docOf(threeParagraphs)
    const reader = docOf(threeParagraphs)
    const base = Y.encodeStateVector(writer)
    oldBlockText(writer).insert(2, 'QQ')
    oldBlockText(other).insert(2, 'ZZ')
    const typed = [Y.encodeStateAsUpdate(writer, base), Y.encodeStateAsUpdate(other, base)]
    removeOldBlock(reader)

    const found = removalsOnApply(reader, typed, writer)

    expect(found).toEqual([neverKept('QQ')])
  })

  // A third tab sends ZZ at `offset` in the old block once the type-back is out, so the taking-on
  // tab never sees it, then pulls the taken-on heading and the type-back together
  async function thirdTabTyping(offset: number) {
    let third!: CollabRoom
    const thirdReported: Removal[] = []
    const { first, typing } = await takeOverHeading('defgh', async (server) => {
      third = await join(server.endpoints(), { pollMs: 3_600_000 })
      watchRemovals(third, (removals) => thirdReported.push(...removals))
    })
    await typing.flush()
    expect(roomText(third, 1).toString()).toBe('defgh')
    roomText(third, 1).insert(offset, 'ZZ')
    await third.flush()
    await third.pull()
    await third.flush()
    await typing.pull()
    await first.pull()
    return { rooms: [first, typing, third], thirdReported }
  }

  it("types back a third tab's sent text once it pulls the taken-on heading and the type-back together (R305)", async () => {
    fakeLocks()
    try {
      const { rooms, thirdReported } = await thirdTabTyping(4)

      for (const room of rooms) {
        expect(roomBlocks(room)).toEqual(['paragraph abc', 'heading deQQfgZZh', 'paragraph xyz'])
      }

      expect(thirdReported).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("reports a third tab's text sent where the type-back's tab typed too (R305)", async () => {
    fakeLocks()
    try {
      const { rooms, thirdReported } = await thirdTabTyping(2)

      for (const room of rooms) {
        expect(roomBlocks(room)).toEqual(['paragraph abc', 'heading deQQfgh', 'paragraph xyz'])
      }

      const runs = [{ offset: 2, text: 'ZZ', attrs: {} }]
      expect(thirdReported).toEqual([{ ...lostQQ, runs, isUncertain: true }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('types back what a row removed though a row pulled with it typed into its copy (R297)', async () => {
    fakeTime()
    const server = fakeServer()
    const writing = await join(server.endpoints())
    Y.applyUpdate(writing.doc, threeParagraphs)
    await writing.flush()
    const typing = await join(offlinePushes(server))
    const reported: Removal[] = []
    watchRemovals(typing, (removals) => reported.push(...removals))

    makeRoomHeading(writing, 'defgh')
    await writing.flush()
    roomText(writing, 1).insert(5, 'ZZ')
    await writing.flush()
    roomText(typing, 1).insert(4, 'RR')
    await typing.pull()

    expect(roomBlocks(typing)).toEqual(['paragraph abc', 'heading defgRRhZZ', 'paragraph xyz'])
    expect(reported).toEqual([])
  })

  it('reports what a row removed when a row pulled with it deleted part of its copy (R305)', async () => {
    fakeTime()
    const server = fakeServer()
    const writing = await join(server.endpoints())
    Y.applyUpdate(writing.doc, threeParagraphs)
    await writing.flush()
    const typing = await join(offlinePushes(server))
    const reported: Removal[] = []
    watchRemovals(typing, (removals) => reported.push(...removals))

    makeRoomHeading(writing, 'defgh')
    await writing.flush()
    roomText(writing, 1).delete(0, 1)
    await writing.flush()
    roomText(typing, 1).insert(2, 'QQ')
    await typing.pull()

    expect(roomBlocks(typing)).toEqual(['paragraph abc', 'heading efgh', 'paragraph xyz'])
    expect(reported).toEqual([lostQQ])
  })

  // One pull: a row deletes `de` in place, then a row from another tab makes the block a heading
  async function deleteThenRestructure(hasSeenDelete: boolean) {
    fakeTime()
    const server = fakeServer()
    const deleting = await join(server.endpoints())
    Y.applyUpdate(deleting.doc, threeParagraphs)
    await deleting.flush()
    const restructuring = await join(server.endpoints())
    const typing = await join(offlinePushes(server))
    const reported: Removal[] = []
    watchRemovals(typing, (removals) => reported.push(...removals))

    roomText(deleting, 1).delete(0, 2)
    await deleting.flush()
    if (hasSeenDelete) {
      await restructuring.pull()
    }

    makeRoomHeading(restructuring, roomText(restructuring, 1).toString())
    await restructuring.flush()
    roomText(typing, 1).insert(2, 'QQ')
    await typing.pull()
    return { typing, reported }
  }

  it('reports what a restructure removed when a row pulled before it deleted part of the old text', async () => {
    const { typing, reported } = await deleteThenRestructure(true)

    expect(roomBlocks(typing)).toEqual(['paragraph abc', 'heading fgh', 'paragraph xyz'])
    expect(reported).toEqual([lostQQ])
  })

  it('types back what a restructure removed when a row pulled with it deleted old text the restructure copied', async () => {
    const { typing, reported } = await deleteThenRestructure(false)

    expect(roomBlocks(typing)).toEqual(['paragraph abc', 'heading deQQfgh', 'paragraph xyz'])
    expect(reported).toEqual([])
  })

  it('reports instead of typing back when the room cannot write (R282)', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [headingTab, typingTab] = tabs
    makeHeading(headingTab, 'defgh')
    typeQQ(typingTab, 'defgh')
    typingTab.room.canWrite = false

    await sendInOrder(tabs, tabs)

    expect(blocks(typingTab)).toEqual(['paragraph abc', 'heading defgh', 'paragraph xyz'])
    expect(typingTab.reported).toEqual([lostQQ])
  })

  it('stops watching once stopped', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [headingTab, typingTab] = tabs
    typingTab.room.canWrite = false
    const stoppedReports: Removal[] = []
    watchRemovals(typingTab.room, (removals) => stoppedReports.push(...removals))()
    makeHeading(headingTab, 'defgh')
    typeQQ(typingTab, 'defgh')

    await sendInOrder(tabs, tabs)

    expect([typingTab.reported, stoppedReports]).toEqual([[lostQQ], []])
  })

  it('reports what it collected but was never told of once stopped, typing none of it back', async () => {
    const [headingTab, typingTab] = await openTabs(threeParagraphs, 2)
    const stoppedReports: Removal[] = []
    const stop = watchRemovals(typingTab.room, (removals) => stoppedReports.push(...removals))
    makeHeading(headingTab, 'defgh')
    typeQQ(typingTab, 'defgh')
    const row = sendRow(headingTab)!
    typingTab.ydoc.transact((transaction) => {
      transaction.meta.set(APPLIED_UPDATE, [row])
      Y.applyUpdate(typingTab.ydoc, row, REMOTE)
    }, REMOTE)

    stop()

    expect(blocks(typingTab)).toEqual(['paragraph abc', 'heading defgh', 'paragraph xyz'])
    expect([stoppedReports, typingTab.reported]).toEqual([[lostQQ], []])
  })

  it('leaves typed-back text in place when the tab undoes', async () => {
    const tabs = await openTabs(threeParagraphs, 2)
    const [headingTab, typingTab] = tabs
    makeHeading(headingTab, 'defgh')
    typeQQ(typingTab, 'defgh')
    await sendInOrder(tabs, tabs)

    typingTab.editor.commands.undo()
    await syncAll(tabs)

    for (const tab of tabs) {
      expect(blocks(tab)).toEqual(['paragraph abc', 'heading deQQfgh', 'paragraph xyz'])
    }
  })
})

describe("work a tab takes on that the doc already held as another tab's (R310)", () => {
  // A row that makes the old block a heading, from a tab that never saw the typing
  function unseenRestructure() {
    const other = docOf(threeParagraphs)
    const base = Y.encodeStateVector(other)
    removeOldBlock(other)
    return Y.encodeStateAsUpdate(other, base)
  }

  // The writer types into the old block, an update per edit as its outbox keeps them, the reader
  // pulls that as another tab's row, `after` runs on the reader, then the reader takes the work on
  function adoptHeld(
    type: (old: Y.XmlText) => void,
    after: (reader: Y.Doc) => void,
    reader = docOf(threeParagraphs),
  ) {
    const writer = docOf(threeParagraphs)
    const typed: Uint8Array[] = []
    writer.on('update', (update: Uint8Array) => typed.push(update))
    type(oldBlockText(writer))
    Y.applyUpdate(reader, Y.mergeUpdates(typed), REMOTE)
    after(reader)
    return removalsOnApply(reader, typed, writer, ADOPT)
  }

  function typeQQAt2(old: Y.XmlText) {
    old.insert(2, 'QQ')
  }

  function applyRestructure(reader: Y.Doc) {
    Y.applyUpdate(reader, unseenRestructure(), REMOTE)
  }

  it('reports my text the doc held once a row removed its block', () => {
    expect(adoptHeld(typeQQAt2, applyRestructure)).toEqual([neverKept('QQ')])
  })

  it('reports nothing of held text still in the doc', () => {
    expect(adoptHeld(typeQQAt2, () => {})).toEqual([])
  })

  it('reports nothing of work that waits on a change the doc never got', () => {
    const writer = docOf(threeParagraphs)
    const typed: Uint8Array[] = []
    writer.on('update', (update: Uint8Array) => typed.push(update))
    oldBlockText(writer).insert(2, 'QQ')
    oldBlockText(writer).insert(4, 'RR')
    const reader = docOf(threeParagraphs)

    const found = removalsOnApply(reader, typed.slice(1), writer, ADOPT)

    const isWaiting = !!reader.store.pendingStructs
    expect([found, oldBlockText(reader).toString(), isWaiting]).toEqual([[], 'defgh', true])
  })

  it('reports nothing of held text someone deleted in a block still there', () => {
    const found = adoptHeld(typeQQAt2, (reader) => oldBlockText(reader).delete(2, 2))

    expect(found).toEqual([])
  })

  function typeAndDeleteQQ(old: Y.XmlText) {
    old.insert(2, 'QQ')
    old.delete(2, 2)
  }

  it('reports nothing of held text the closed tab deleted itself', () => {
    expect(adoptHeld(typeAndDeleteQQ, applyRestructure)).toEqual([])
  })

  it('reports held text in a removed block the doc keeps uncollected', () => {
    const reader = new Y.Doc({ gc: false })
    Y.applyUpdate(reader, threeParagraphs)

    expect(adoptHeld(typeQQAt2, applyRestructure, reader)).toEqual([neverKept('QQ')])
  })

  it('reports held bold text as bold', () => {
    const found = adoptHeld((old) => old.insert(2, 'QQ', { bold: {} }), applyRestructure)

    expect(found).toEqual([
      { ...neverKept('QQ'), runs: [{ offset: 0, text: 'QQ', attrs: { bold: {} } }] },
    ])
  })

  // A restructure that saw the typing carries it into the heading, which no adopt can tell
  function carryIntoHeading(reader: Y.Doc) {
    const words = oldBlockText(reader).toString()
    const heading = new Y.XmlElement('heading')
    heading.insert(0, [new Y.XmlText(words)])
    const body = reader.getXmlFragment(BODY_FIELD)
    reader.transact(() => {
      body.delete(1, 1)
      body.insert(1, [heading])
    })
  }

  it('reports held text a restructure carried into its heading, as a spare copy', () => {
    const reader = docOf(threeParagraphs)

    const found = adoptHeld(typeQQAt2, carryIntoHeading, reader)

    expect([oldBlockText(reader).toString(), found]).toEqual(['deQQfgh', [neverKept('QQ')]])
  })

  it('keys lost text by every lost character, alike each time the same work is taken on', () => {
    const writer = docOf(threeParagraphs)
    const base = Y.encodeStateVector(writer)
    oldBlockText(writer).insert(2, 'QQ')
    const typedQQ = Y.encodeStateAsUpdate(writer, base)
    oldBlockText(writer).insert(4, 'R')
    const typedQQR = Y.encodeStateAsUpdate(writer, base)

    const keys = [typedQQ, typedQQ, typedQQR].map((typed) => {
      const reader = docOf(threeParagraphs)
      Y.applyUpdate(reader, typed, REMOTE)
      applyRestructure(reader)
      return removalsOnApply(reader, [typed], writer, ADOPT).map((removal) => removal.key)
    })

    const id = writer.clientID
    expect(keys).toEqual([[`${id}:0+2`], [`${id}:0+2`], [`${id}:0+3`]])
  })

  it('keys a lost mention by its own item, alike each time the same work is taken on', () => {
    const writer = docOf(threeParagraphs)
    const base = Y.encodeStateVector(writer)
    ;(oldBlockText(writer).parent as Y.XmlElement).insert(1, [mention()])
    const typed = Y.encodeStateAsUpdate(writer, base)

    const keys = [typed, typed].map((update) => {
      const reader = docOf(threeParagraphs)
      Y.applyUpdate(reader, update, REMOTE)
      applyRestructure(reader)
      return removalsOnApply(reader, [update], writer, ADOPT).map((removal) => removal.key)
    })

    const id = writer.clientID
    expect(keys).toEqual([[`${id}:0+1`], [`${id}:0+1`]])
  })

  function typeAndCut(old: Y.XmlText) {
    old.insert(2, 'QQ')
    old.insert(4, 'RR')
    old.delete(3, 1)
  }

  it('keys a lost run the closed tab deleted inside by each stretch it lost', () => {
    const found = adoptHeld(typeAndCut, applyRestructure)

    const runs = found.map((removal) => removal.kind === 'text' && removal.runs[0].text)
    expect([runs, found.map((removal) => removal.key)]).toEqual([
      ['QRR'],
      [expect.stringMatching(/^\d+:0\+1,\d+:2\+2$/)],
    ])
  })

  it('reports a held mention as one lost node', () => {
    const found = adoptHeld(
      (old) => (old.parent as Y.XmlElement).insert(1, [mention()]),
      applyRestructure,
    )

    expect(found).toEqual([{ kind: 'node', name: 'mention', attrs: {}, key: expect.any(String) }])
  })

  // Endpoints whose pushes reach the server and whose answers never come back, as a closing page's keepalive
  function unansweredPushes(server: FakeServer) {
    const endpoints = { ...server.endpoints() }
    const push = endpoints.push
    endpoints.push = async (body, request) => {
      await push(body, request)
      throw new TypeError('Failed to fetch')
    }

    return endpoints
  }

  it("reports a closed tab's sent typing a live tab pulled as another's, once it takes the work on", async () => {
    fakeLocks()
    fakeTime()
    try {
      const server = fakeServer()
      const first = await join(server.endpoints())
      Y.applyUpdate(first.doc, threeParagraphs)
      await first.flush()
      const kept = await device()
      const live = await join(server.endpoints(), { device: kept })
      const closing = await join(unansweredPushes(server), { device: kept, pollMs: 3_600_000 })
      const reported: Removal[] = []
      watchRemovals(live, (removals) => reported.push(...removals))

      makeRoomHeading(first, 'defgh')
      roomText(closing, 1).insert(2, 'QQ')
      await vi.advanceTimersByTimeAsync(0)
      await idle()
      await first.flush()
      await live.pull()
      const isPulledFirst = live.doc.store.clients.has(closing.doc.clientID)
      const pulledReports = [...reported]
      await closing.close()
      await vi.advanceTimersByTimeAsync(60_000)
      await idle()

      expect([isPulledFirst, pulledReports, roomBlocks(live), reported]).toEqual([
        true,
        [],
        ['paragraph abc', 'heading defgh', 'paragraph xyz'],
        [neverKept('QQ')],
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
