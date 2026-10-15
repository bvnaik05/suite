import type { CollabRoom } from '@suite/collab-client'
import { toast } from 'frappe-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import type { DocumentSession } from '@/apps/drive'
import { anchorEnds, DOCUMENT_ANCHOR, encodeAnchor } from '@/apps/writer/collab/anchors'
import { readDrafts } from '@/apps/writer/recovery/commentDrafts'

import { useCommentDrafts } from './useCommentDrafts'

vi.mock('frappe-ui', () => ({ toast: { error: vi.fn() } }))

afterEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

// An anchor on "hello" written into the doc, whose end characters the room below holds once saved
function helloAnchor(doc: Y.Doc) {
  const content = new Y.XmlText()
  doc.getXmlFragment('default').insert(0, [content])
  content.insert(0, 'hello')
  return encodeAnchor(
    Y.createRelativePositionFromTypeIndex(content, 0, 0),
    Y.createRelativePositionFromTypeIndex(content, 5, -1),
    'hello',
  )
}

function refused() {
  return Promise.reject(new Error('Not allowed'))
}

function keyOf(id: Y.ID) {
  return `${id.client}:${id.clock}`
}

// A room that holds no text on the server until told to
function fakeRoom() {
  const listeners = new Set<() => void>()
  const saved = new Set<string>()
  const state = { stopped: null as string | null }
  const room = {
    doc: new Y.Doc(),
    get stopped() {
      return state.stopped
    },
    committedCovers: (items: readonly Y.ID[]) => items.every((id) => saved.has(keyOf(id))),
    onChange(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as CollabRoom
  function tell() {
    for (const listener of [...listeners]) {
      listener()
    }
  }

  function save(anchor: string) {
    for (const id of anchorEnds(anchor)) {
      saved.add(keyOf(id))
    }

    tell()
  }

  function stop() {
    state.stopped = 'refused'
    tell()
  }

  return { room, save, stop }
}

function driveComments(answers: (() => Promise<unknown>)[] = []) {
  const posts: unknown[][] = []
  const create = vi.fn((...input: unknown[]) => {
    posts.push(input)
    return answers.shift()?.() ?? Promise.resolve({ name: 'thread-1' })
  })
  const session = { nodeId: 'doc-1', comments: { create } } as unknown as Pick<
    DocumentSession,
    'comments' | 'nodeId'
  >
  return { session, posts }
}

function openDrafts(session: ReturnType<typeof driveComments>['session'], room: CollabRoom | null) {
  const refreshThreads = vi.fn(async () => {})
  const drafts = useCommentDrafts({ session, user: 'ann', room: () => room, refreshThreads })
  return { ...drafts, refreshThreads }
}

function settled() {
  return new Promise((resolve) => setTimeout(resolve))
}

describe('posting a comment on text', () => {
  it('waits until its text is saved, then posts once with its client id and forgets the draft', async () => {
    const { room, save } = fakeRoom()
    const { session, posts } = driveComments()
    const { drafts, start, write, post, refreshThreads } = openDrafts(session, room)
    const anchor = helloAnchor(room.doc)
    start(anchor)
    const [draft] = drafts.value
    write(draft, '  Check this  ')

    const posting = post(draft)
    await settled()
    const waited = [posts.length, draft.isPosting]
    save(anchor)

    expect([await posting, waited, posts]).toEqual([
      'thread-1',
      [0, true],
      [[anchor, 'Check this', undefined, draft.clientId]],
    ])
    expect([drafts.value, readDrafts('ann', 'doc-1'), refreshThreads.mock.calls.length]).toEqual([
      [],
      [],
      1,
    ])
  })

  it('posts nothing and keeps the draft when its text can no longer be saved', async () => {
    const { room, stop } = fakeRoom()
    const { session, posts } = driveComments()
    const { drafts, start, write, post } = openDrafts(session, room)
    start(helloAnchor(room.doc))
    write(drafts.value[0], 'Kept')

    const posting = post(drafts.value[0])
    stop()

    expect([await posting, posts, drafts.value[0].isPosting]).toEqual([null, [], false])
    expect(readDrafts('ann', 'doc-1').map((draft) => draft.text)).toEqual(['Kept'])
    expect(vi.mocked(toast.error)).toHaveBeenCalledOnce()
  })

  it('keeps a draft Drive refused, and sends the same client id when tried again', async () => {
    const { room, save } = fakeRoom()
    const { session, posts } = driveComments([refused])
    const { drafts, start, write, post } = openDrafts(session, room)
    const anchor = helloAnchor(room.doc)
    save(anchor)
    start(anchor)
    write(drafts.value[0], 'Again')
    const [draft] = drafts.value

    const results = [await post(draft), readDrafts('ann', 'doc-1').length, await post(draft)]

    expect([results, posts.map((input) => input[3])]).toEqual([
      [null, 1, 'thread-1'],
      [draft.clientId, draft.clientId],
    ])
  })

  it('shows the drafts left on this device when the document opens again', () => {
    const { room } = fakeRoom()
    const first = openDrafts(driveComments().session, room)
    first.start(helloAnchor(room.doc))
    first.write(first.drafts.value[0], 'Left here')

    const reopened = openDrafts(driveComments().session, room)

    expect(reopened.drafts.value.map((draft) => [draft.text, draft.isPosting])).toEqual([
      ['Left here', false],
    ])
  })

  it('posts nothing when the draft is discarded while its text saves', async () => {
    const { room, save } = fakeRoom()
    const { session, posts } = driveComments()
    const { drafts, start, discard, post } = openDrafts(session, room)
    const anchor = helloAnchor(room.doc)
    start(anchor)
    const [draft] = drafts.value

    const posting = post(draft)
    discard(draft)
    save(anchor)

    expect([await posting, posts, readDrafts('ann', 'doc-1')]).toEqual([null, [], []])
  })

  it('keeps the draft as sent while its text saves, so the device brings it back as sent', async () => {
    const { room } = fakeRoom()
    const { session } = driveComments()
    const { drafts, start, write, post } = openDrafts(session, room)
    start(helloAnchor(room.doc))
    write(drafts.value[0], 'Waiting')

    void post(drafts.value[0])
    const reopened = openDrafts(driveComments().session, room)

    expect(
      reopened.drafts.value.map(({ text, isSent, isPosting }) => [text, isSent, isPosting]),
    ).toEqual([['Waiting', true, false]])
  })

  it('posts nothing, and says so at once, when the commented text is not in this copy', async () => {
    const { room } = fakeRoom()
    const { session, posts } = driveComments()
    const { drafts, start, write, post } = openDrafts(session, room)
    start(helloAnchor(new Y.Doc()))
    write(drafts.value[0], 'Lost text')

    const thread = await post(drafts.value[0])

    expect([thread, posts, readDrafts('ann', 'doc-1').map((draft) => draft.isSent)]).toEqual([
      null,
      [],
      [true],
    ])
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "The text this comment is on wasn't saved, so it wasn't posted.",
    )
  })

  it('posts nothing when this copy has all of the commented text but its last letter', async () => {
    const { room } = fakeRoom()
    const { drafts, start, write, post } = openDrafts(driveComments().session, room)
    const elsewhere = new Y.Doc()
    const content = new Y.XmlText()
    elsewhere.getXmlFragment('default').insert(0, [content])
    content.insert(0, 'hell')
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(elsewhere))
    content.insert(4, 'o')
    start(
      encodeAnchor(
        Y.createRelativePositionFromTypeIndex(content, 0, 0),
        Y.createRelativePositionFromTypeIndex(content, 5, -1),
        'hello',
      ),
    )
    write(drafts.value[0], 'Lost letter')

    void post(drafts.value[0])
    await settled()

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "The text this comment is on wasn't saved, so it wasn't posted.",
    )
  })
})

describe('posting a comment on the whole document', () => {
  it('posts at once, before the room connects, with nothing to wait for', async () => {
    const { session, posts } = driveComments()
    const { drafts, start, write, post } = openDrafts(session, null)
    start(DOCUMENT_ANCHOR)
    write(drafts.value[0], ' Ship it ')
    const [draft] = drafts.value

    const thread = await post(draft)

    expect([thread, posts, drafts.value]).toEqual([
      'thread-1',
      [[DOCUMENT_ANCHOR, 'Ship it', undefined, draft.clientId]],
      [],
    ])
  })

  it('keeps a comment on text unsent while there is no room to save its text', async () => {
    const { session, posts } = driveComments()
    const { drafts, start, write, post } = openDrafts(session, null)
    start(helloAnchor(new Y.Doc()))
    write(drafts.value[0], 'Too soon')
    const [draft] = drafts.value

    const thread = await post(draft)

    expect([thread, posts, drafts.value.map((kept) => kept.isSent)]).toEqual([null, [], [true]])
  })

  it('makes one thread when Drive took the comment but its answer was lost, once sent again', async () => {
    const taken = new Map<string, unknown[]>()
    let isAnswerLost = true
    const create = vi.fn(async (...input: unknown[]) => {
      const clientId = String(input[3])
      if (!taken.has(clientId)) {
        taken.set(clientId, input)
      }

      if (isAnswerLost) {
        isAnswerLost = false
        throw new Error('Connection lost')
      }

      return { name: `thread-${taken.size}` }
    })
    const session = { nodeId: 'doc-1', comments: { create } } as unknown as ReturnType<
      typeof driveComments
    >['session']
    const { drafts, start, write, post } = openDrafts(session, null)
    start(DOCUMENT_ANCHOR)
    write(drafts.value[0], 'Ship it')
    const [draft] = drafts.value

    const results = [await post(draft), await post(draft)]

    expect([results, taken.size, create.mock.calls.length]).toEqual([[null, 'thread-1'], 1, 2])
  })
})

describe('drafts in two tabs of the document', () => {
  function storedValues() {
    const values = new Map<string, string | null>()
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index) ?? ''
      values.set(key, localStorage.getItem(key))
    }

    return values
  }

  // Makes a change as another tab, then tells of each value it changed as a browser tells the other tabs
  function inOtherTab(change: () => void) {
    const before = storedValues()
    change()
    const after = storedValues()
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const oldValue = before.get(key) ?? null
      const newValue = after.get(key) ?? null
      if (oldValue !== newValue) {
        window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue }))
      }
    }
  }

  it('drops a draft another tab posted or discarded, and takes on none it starts', () => {
    const { room } = fakeRoom()
    const anchor = helloAnchor(room.doc)
    const first = openDrafts(driveComments().session, room)
    first.start(anchor)
    first.write(first.drafts.value[0], 'Shared')
    const second = openDrafts(driveComments().session, room)
    second.start(anchor)
    second.write(second.drafts.value[1], 'Only here')

    inOtherTab(() => {
      first.discard(first.drafts.value[0])
      first.start(anchor)
    })

    expect(second.drafts.value.map((draft) => draft.text)).toEqual(['Only here'])
  })

  it('drops a draft started here once a tab opened after it discards it', () => {
    const { room } = fakeRoom()
    const anchor = helloAnchor(room.doc)
    const first = openDrafts(driveComments().session, room)
    first.start(anchor)
    first.write(first.drafts.value[0], 'Started here')
    const second = openDrafts(driveComments().session, room)

    inOtherTab(() => second.discard(second.drafts.value[0]))

    expect(first.drafts.value).toEqual([])
  })

  it('keeps a draft this tab could not store when another tab changes the drafts', () => {
    const { room } = fakeRoom()
    const anchor = helloAnchor(room.doc)
    const first = openDrafts(driveComments().session, room)
    const second = openDrafts(driveComments().session, room)
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    second.start(anchor)
    second.write(second.drafts.value[0], 'Not stored')
    full.mockRestore()

    inOtherTab(() => first.start(anchor))

    expect(second.drafts.value.map((draft) => draft.text)).toEqual(['Not stored'])
  })
})
