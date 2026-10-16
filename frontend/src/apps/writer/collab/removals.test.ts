import { APPLIED_UPDATE, REMOTE, type CollabRoom } from '@suite/collab-client'
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
import { typeBack, watchRemovals, type Removal } from '@/apps/writer/collab/removals'
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

  // A tab types QQ into defgh and closes without sending it, another makes the block a heading and sends it,
  // then a tab opens on the same device without the network, watched before it applies anything
  async function reopenAfterRestructure() {
    fakeTime()
    const server = fakeServer()
    const first = await join(server.endpoints())
    Y.applyUpdate(first.doc, threeParagraphs)
    await first.flush()
    const kept = await device()
    const closing = await join(offlinePushes(server), { device: kept })
    roomText(closing, 1).insert(2, 'QQ')
    await vi.advanceTimersByTimeAsync(0)
    await idle()
    await closing.close()
    makeRoomHeading(first, 'defgh')
    await first.flush()
    server.access.online = false
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
      const { rooms, reported } = await reopenAfterRestructure()

      for (const room of rooms) {
        expect(roomBlocks(room)).toEqual(['paragraph abc', 'heading deQQfgh', 'paragraph xyz'])
      }

      expect(reported).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
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
