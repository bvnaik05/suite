import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'

import type { DocumentThread } from '@/apps/drive'
import type { ThreadPlace } from '@/apps/writer/collab/places'

import CommentList from './CommentList.vue'
import type { ThreadActions } from './useDocumentPanel'

const confirmed = vi.hoisted(() => ({ asked: [] as string[], answer: true }))

interface ShownToast {
  message: string
  duration: number
  action: { label: string; onClick: () => void }
}

const toasts = vi.hoisted(() => [] as ShownToast[])

vi.mock('@/platform/feedback', () => ({
  confirm: async ({ title }: { title: string }) => {
    confirmed.asked.push(title)
    return confirmed.answer
  },
  toast: {
    success: (message: string, options: Omit<ShownToast, 'message'>) =>
      toasts.push({ message, ...options }),
  },
}))

vi.mock('frappe-ui', async () => {
  const { defineComponent: define, h: render, ref: state } = await import('vue')
  // A text box whose parent can focus it, like frappe-ui's own
  function box(tag: 'input' | 'textarea') {
    return define({
      props: { modelValue: String },
      emits: ['update:modelValue'],
      setup(props, { emit, expose }) {
        const field = state<HTMLInputElement | null>(null)
        expose({ focus: () => field.value?.focus() })
        function write(event: Event) {
          emit('update:modelValue', (event.target as HTMLInputElement).value)
        }

        return () => render(tag, { ref: field, value: props.modelValue, onInput: write })
      },
    })
  }

  return {
    Avatar: { render: () => null },
    Button: define({
      props: { label: String, type: String },
      emits: ['click'],
      setup:
        (props, { emit }) =>
        () =>
          render(
            'button',
            { type: props.type ?? 'button', onClick: () => emit('click') },
            props.label,
          ),
    }),
    TabButtons: define({
      props: { modelValue: String, options: Array as () => { label: string; value: string }[] },
      emits: ['update:modelValue'],
      setup:
        (props, { emit }) =>
        () =>
          render(
            'div',
            props.options?.map((option) =>
              render(
                'button',
                {
                  role: 'tab',
                  'aria-selected': props.modelValue === option.value,
                  onClick: () => emit('update:modelValue', option.value),
                },
                option.label,
              ),
            ),
          ),
    }),
    Textarea: box('textarea'),
    TextInput: box('input'),
  }
})

vi.mock('@/apps/drive', async () => {
  const { defineComponent: define, h: render, ref: state } = await import('vue')
  return {
    DriveCommentAuthor: define({
      setup:
        (_props, { slots }) =>
        () =>
          render('span', slots.default?.()),
    }),
    GUEST_NAME_LIMIT: 140,
    useDriveGuestName: () => ({
      shown: state(false),
      text: state(''),
      atLimit: state(false),
      maxLength: 140,
      take: () => undefined,
    }),
  }
})

const TODAY = new Date().toISOString()

function comment(name: string, author: string, content: string) {
  return {
    name,
    author,
    author_name: null,
    person: { full_name: author },
    content,
    creation: TODAY,
  }
}

const ON_TEXT = {
  name: 'on-text',
  resolved: false,
  comments: [
    comment('c1', 'Asha Rao', 'Is this right?'),
    comment('c2', 'Ben Ito', 'Yes'),
    comment('c3', 'Asha Rao', 'Thanks'),
  ],
} as unknown as DocumentThread

const WHOLE = {
  name: 'whole',
  resolved: false,
  comments: [comment('c4', 'Ben Ito', 'Looks good overall')],
} as unknown as DocumentThread

const DONE = {
  name: 'done',
  resolved: true,
  comments: [comment('c5', 'Asha Rao', 'Fixed the title'), comment('c6', 'Ben Ito', 'Thanks')],
} as unknown as DocumentThread

const PLACES = new Map<string, ThreadPlace>([
  ['on-text', { kind: 'text', from: 5, to: 9, quote: 'the words' }],
  ['whole', { kind: 'document' }],
  ['done', { kind: 'deleted', quote: 'gone' }],
])

let mounted: App | null = null

// jsdom lays nothing out, so has nothing to scroll
Element.prototype.scrollIntoView = () => {}

afterEach(() => {
  mounted?.unmount()
  document.body.replaceChildren()
  confirmed.asked = []
  confirmed.answer = true
  toasts.length = 0
})

// The list over the three threads, recording each change it asks for and each thread it opens or lights
function showList({
  canComment = true,
  threads = [ON_TEXT, WHOLE, DONE],
  openThread = null as string | null,
  isRefusingResolve = false,
} = {}) {
  const asked: string[] = []
  const opened: (string | null)[] = []
  const lit: (string | null)[] = []
  const shown = ref(openThread)
  function open(name: string | null) {
    opened.push(name)
    shown.value = name
  }

  function record(change: string) {
    asked.push(change)
    return Promise.resolve(true)
  }

  const actions: ThreadActions = {
    addComment: (text) => record(`add "${text}"`),
    reply: (thread, text) => record(`reply ${thread} "${text}"`),
    resolve: async (thread, isResolved) =>
      (await record(`resolve ${thread} ${isResolved}`)) && !isRefusingResolve,
    removeComment: (name) => record(`remove ${name}`),
  }
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(() =>
    h(CommentList, {
      threads,
      places: PLACES,
      canComment,
      actions,
      openThread: shown.value,
      'onUpdate:openThread': open,
      'onUpdate:litThread': (name: string | null) => lit.push(name),
    }),
  )
  app.mount(host)
  mounted = app
  return { host, asked, opened, lit }
}

// Each row's words, one piece of text after another
function rows(host: Element) {
  return [...host.querySelectorAll('li')].map((row) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    const pieces: string[] = []
    while (walker.nextNode()) {
      pieces.push(walker.currentNode.textContent?.trim() ?? '')
    }

    return pieces.filter(Boolean).join(' ')
  })
}

function buttonNamed(host: Element, name: string) {
  return [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === name)
}

function labelled(host: Element, label: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined
}

function rowButton(host: Element, text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('li > button')].find((button) =>
    button.textContent?.includes(text),
  )!
}

async function click(button: HTMLElement | undefined) {
  button!.click()
  await nextTick()
}

async function settled() {
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

function openRows(host: Element) {
  return [...host.querySelectorAll('li > button[aria-expanded="true"]')].map((button) =>
    button.textContent?.includes('Is this right?') ? 'on-text' : 'whole',
  )
}

describe('the comments list', () => {
  it('shows each open thread on one row: who, where, when, the first comment and the replies', () => {
    const { host } = showList()

    expect(rows(host)).toEqual([
      expect.stringMatching(/^Ben Ito Whole document \S.* Looks good overall$/),
      expect.stringMatching(/^Asha Rao \S.* Is this right\? · 2 replies$/),
    ])
  })

  it('counts the threads in the Open and Resolved tabs and shows resolved ones only under Resolved', async () => {
    const { host } = showList()
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)

    await click(buttonNamed(host, 'Resolved 1'))

    expect([tabs, rows(host)]).toEqual([
      ['Open 2', 'Resolved 1'],
      [expect.stringMatching(/^Asha Rao Text deleted \S.* Fixed the title · 1 reply$/)],
    ])
  })

  it('keeps one thread open at a time, and closes it on a second click or Esc', async () => {
    const { host } = showList()
    const seen: string[][] = []

    await click(rowButton(host, 'Looks good overall'))
    seen.push(openRows(host))
    await click(rowButton(host, 'Is this right?'))
    seen.push(openRows(host))
    await click(rowButton(host, 'Is this right?'))
    seen.push(openRows(host))
    await click(rowButton(host, 'Looks good overall'))
    host.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    seen.push(openRows(host))

    expect(seen).toEqual([['whole'], ['on-text'], [], []])
  })

  it('shows an open thread’s quote and every reply', async () => {
    const { host } = showList()

    await click(rowButton(host, 'Is this right?'))
    const text = host.querySelector('li')!.parentElement!.textContent

    expect([text, text?.includes('2 replies')]).toEqual([
      expect.stringMatching(/the words.*Is this right\?.*Ben Ito.*Yes.*Asha Rao.*Thanks/s),
      false,
    ])
  })
})

describe('resolving and reopening a thread', () => {
  it('resolves the open thread from its ✓, closes it, and offers Undo for 5 seconds', async () => {
    const { host, asked } = showList()

    await click(rowButton(host, 'Looks good overall'))
    await click(labelled(host, 'Resolve'))
    await settled()

    const shown = toasts.map(({ message, duration, action }) => [message, duration, action.label])
    expect([asked, openRows(host), shown]).toEqual([
      ['resolve whole true'],
      [],
      [['Comment resolved', 5000, 'Undo']],
    ])
  })

  it('reopens that thread once on Undo', async () => {
    const { host, asked } = showList()

    await click(rowButton(host, 'Looks good overall'))
    await click(labelled(host, 'Resolve'))
    await settled()
    toasts[0].action.onClick()
    await settled()

    expect(asked).toEqual(['resolve whole true', 'resolve whole false'])
  })

  it('offers no Undo when the thread could not be resolved', async () => {
    const { host, asked } = showList({ isRefusingResolve: true })

    await click(rowButton(host, 'Looks good overall'))
    await click(labelled(host, 'Resolve'))
    await settled()

    expect([asked, toasts]).toEqual([['resolve whole true'], []])
  })

  it('sends one resolve for two quick clicks on the same ✓', async () => {
    const { host, asked } = showList()
    await click(rowButton(host, 'Looks good overall'))
    const resolveButton = labelled(host, 'Resolve')!

    resolveButton.click()
    resolveButton.click()
    await settled()

    expect(asked).toEqual(['resolve whole true'])
  })

  it('lets a thread be resolved again once a refused resolve comes back', async () => {
    const { host, asked } = showList({ isRefusingResolve: true })
    await click(rowButton(host, 'Looks good overall'))
    await click(labelled(host, 'Resolve'))
    await settled()

    await click(labelled(host, 'Resolve'))
    await settled()

    expect(asked).toEqual(['resolve whole true', 'resolve whole true'])
  })

  it('reopens a resolved thread from ↺ in the same spot, with no message', async () => {
    const { host, asked } = showList()

    await click(buttonNamed(host, 'Resolved 1'))
    const hasResolve = !!labelled(host, 'Resolve')
    await click(labelled(host, 'Reopen'))
    await settled()

    expect([hasResolve, asked, toasts]).toEqual([false, ['resolve done false'], []])
  })
})

describe('replying in an open thread', () => {
  function replyBox() {
    return document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')
  }

  async function type(text: string) {
    replyBox()!.value = text
    replyBox()!.dispatchEvent(new Event('input'))
    await nextTick()
  }

  async function press(options: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...options })
    replyBox()!.dispatchEvent(event)
    await settled()
    return event.defaultPrevented
  }

  it('puts the cursor in the reply box of a thread opened from the list', async () => {
    const { host } = showList()

    await click(rowButton(host, 'Is this right?'))
    await nextTick()

    expect([replyBox(), document.activeElement === replyBox()]).toEqual([expect.anything(), true])
  })

  it('leaves the cursor where it was when the thread is opened from its text', async () => {
    showList({ openThread: 'on-text' })
    await settled()

    expect([replyBox(), document.activeElement === replyBox()]).toEqual([expect.anything(), false])
  })

  it('sends the reply on Enter and empties the box', async () => {
    const { host, asked } = showList()
    await click(rowButton(host, 'Is this right?'))

    await type('  Agreed ')
    const isKeptOutOfBox = await press({})

    expect([asked, replyBox()?.value, isKeptOutOfBox]).toEqual([
      ['reply on-text "Agreed"'],
      '',
      true,
    ])
  })

  it('sends nothing on Shift+Enter or while a word is being composed', async () => {
    const { host, asked } = showList()
    await click(rowButton(host, 'Is this right?'))

    await type('Agreed')
    const pressed = [await press({ shiftKey: true }), await press({ isComposing: true })]

    expect([asked, pressed]).toEqual([[], [false, false]])
  })

  it('sends one reply for two quick presses of Enter', async () => {
    const { host, asked } = showList()
    await click(rowButton(host, 'Is this right?'))
    await type('Agreed')

    const enter = { key: 'Enter', cancelable: true }
    replyBox()!.dispatchEvent(new KeyboardEvent('keydown', enter))
    replyBox()!.dispatchEvent(new KeyboardEvent('keydown', enter))
    await settled()

    expect(asked).toEqual(['reply on-text "Agreed"'])
  })

  it('shows the send arrow only once there is text, and sends from it', async () => {
    const { host, asked } = showList()
    await click(rowButton(host, 'Is this right?'))

    const isShownEmpty = !!labelled(host, 'Send reply')
    await type('Agreed')
    await click(labelled(host, 'Send reply'))
    await settled()

    expect([isShownEmpty, asked]).toEqual([false, ['reply on-text "Agreed"']])
  })

  it('shows the keys to use only while the box is empty and has the cursor', async () => {
    const { host } = showList()
    const hint = 'Enter to send · Shift+Enter for a new line'
    await click(rowButton(host, 'Is this right?'))
    await nextTick()

    const seen = [host.textContent?.includes(hint)]
    await type('A')
    seen.push(host.textContent?.includes(hint))
    await type('')
    replyBox()!.blur()
    await nextTick()
    seen.push(host.textContent?.includes(hint))

    expect(seen).toEqual([true, false, false])
  })

  it('keeps a half-typed reply when another thread is opened and back', async () => {
    const { host } = showList()
    await click(rowButton(host, 'Is this right?'))
    await type('Half a reply')

    await click(rowButton(host, 'Looks good overall'))
    const otherBox = replyBox()?.value
    await click(rowButton(host, 'Is this right?'))

    expect([otherBox, replyBox()?.value]).toEqual(['', 'Half a reply'])
  })

  it('offers no reply box in a resolved thread', async () => {
    const { host } = showList()

    await click(buttonNamed(host, 'Resolved 1'))
    await click(rowButton(host, 'Fixed the title'))

    expect(replyBox()).toBeNull()
  })
})

describe('commenting on the whole document', () => {
  function documentBox() {
    return document.querySelector<HTMLTextAreaElement>('textarea')
  }

  async function type(text: string) {
    documentBox()!.value = text
    documentBox()!.dispatchEvent(new Event('input'))
    await nextTick()
  }

  it('turns the line into a focused box, and posts what is typed', async () => {
    const { host, asked } = showList()

    await click(buttonNamed(host, 'Comment on the whole document…'))
    await nextTick()
    const isFocused = document.activeElement === documentBox()
    await type('  Ship it ')
    host.querySelector('form')!.requestSubmit()
    await settled()

    expect([isFocused, asked, documentBox()]).toEqual([true, ['add "Ship it"'], null])
  })

  it('opens the box under the Open tab when asked from elsewhere', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const list = ref<{ startDocumentComment(): Promise<void> } | null>(null)
    const actions = {} as ThreadActions
    const props = { ref: list, threads: [DONE], places: PLACES, canComment: true, actions }
    mounted = createApp(() => h(CommentList, props))
    mounted.mount(host)
    await click(buttonNamed(host, 'Resolved 1'))

    await list.value!.startDocumentComment()

    const selected = host.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    expect([selected, document.activeElement === documentBox()]).toEqual(['Open 0', true])
  })

  it('closes an empty box without asking, and asks before dropping typed words', async () => {
    const { host } = showList()

    await click(buttonNamed(host, 'Comment on the whole document…'))
    await click(buttonNamed(host, 'Cancel'))
    await settled()
    const afterEmpty = [documentBox(), confirmed.asked.length]
    await click(buttonNamed(host, 'Comment on the whole document…'))
    await type('Half a thought')
    confirmed.answer = false
    await click(buttonNamed(host, 'Cancel'))
    await settled()

    expect([afterEmpty, documentBox()?.value, confirmed.asked]).toEqual([
      [null, 0],
      'Half a thought',
      ['Discard comment?'],
    ])
  })
})

describe('an empty tab and a reader who can’t comment', () => {
  it('says how to start a comment when nothing is open', () => {
    const { host } = showList({ threads: [DONE] })

    expect(host.textContent).toContain(
      'No open comments. Select text and press Comment, or comment on the whole document above.',
    )
  })

  it('offers a reader no top line, reply, resolve or delete, in either tab', async () => {
    const { host } = showList({ canComment: false, threads: [ON_TEXT, DONE] })
    function extras() {
      const labels = [...host.querySelectorAll('button')].map(
        (button) => button.textContent?.trim() || button.getAttribute('aria-label'),
      )
      const rest = labels.filter((label) => !/^(Open|Resolved) \d$|Is this|Fixed/.test(label ?? ''))
      return [host.querySelector('textarea'), rest]
    }

    await click(rowButton(host, 'Is this right?'))
    const inOpen = extras()
    await click(buttonNamed(host, 'Resolved 1'))
    await click(rowButton(host, 'Fixed the title'))

    expect([inOpen, extras()]).toEqual([
      [null, []],
      [null, []],
    ])
  })

  it('tells a reader only that nothing is open', () => {
    const { host } = showList({ canComment: false, threads: [] })

    expect(host.querySelector('p')?.textContent).toBe('No open comments.')
  })
})

describe('the list and the editor', () => {
  function point(host: Element, text: string, event: 'mouseenter' | 'mouseleave') {
    rowButton(host, text).parentElement!.dispatchEvent(new MouseEvent(event))
  }

  it('lights a thread’s text while its row is pointed at, and clears it after', () => {
    const { host, lit } = showList()

    point(host, 'Is this right?', 'mouseenter')
    point(host, 'Is this right?', 'mouseleave')

    expect(lit).toEqual(['on-text', null])
  })

  it('shows a thread opened from its text under its own tab', async () => {
    const { host } = showList({ openThread: 'done' })
    await settled()

    const selected = host.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    const isOpen = rowButton(host, 'Fixed the title').getAttribute('aria-expanded')
    expect([selected, isOpen]).toEqual(['Resolved 1', 'true'])
  })

  it('leaves no text lit once the panel closes', () => {
    const { host, opened, lit } = showList({ openThread: 'on-text' })
    point(host, 'Looks good overall', 'mouseenter')

    mounted!.unmount()
    mounted = null

    expect([opened, lit]).toEqual([[null], ['whole', null]])
  })
})
