import { beforeEach, describe, expect, it, vi } from 'vitest'

const shown: { action: { onClick: () => void }; onAutoClose: () => void; onDismiss: () => void }[] =
  []
vi.mock('frappe-ui', async (original) => ({
  ...(await original<typeof import('frappe-ui')>()),
  toast: {
    dismiss: vi.fn(),
    success: vi.fn((_message: string, options: (typeof shown)[number]) => shown.push(options)),
    error: vi.fn(),
  },
}))
vi.stubGlobal('__', (text: string) => text)

const load = async () => (await import('./index')).commitAfterUndo

describe('commitAfterUndo', () => {
  beforeEach(() => (shown.length = 0))

  it('puts the rows back on Undo and sends nothing', async () => {
    const commitAfterUndo = await load()
    const commit = vi.fn(() => Promise.resolve())
    const restore = vi.fn()
    commitAfterUndo({ message: 'Draft discarded.', commit, restore })
    shown[0].action.onClick()
    shown[0].onDismiss()
    expect(restore).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
  })

  it('sends the removal once the toast is gone, and only once', async () => {
    const commitAfterUndo = await load()
    const commit = vi.fn(() => Promise.resolve())
    const restore = vi.fn()
    commitAfterUndo({ message: 'Draft discarded.', commit, restore })
    shown[0].onAutoClose()
    shown[0].onDismiss()
    expect(commit).toHaveBeenCalledOnce()
    expect(restore).not.toHaveBeenCalled()
  })

  it('offers the same Undo to Cmd/Ctrl+Z until the removal is sent', async () => {
    const commitAfterUndo = await load()
    const commit = vi.fn(() => Promise.resolve())
    const restore = vi.fn()
    let slot: (() => void) | undefined
    const retire = vi.fn((action: () => void) => slot === action && (slot = undefined))
    commitAfterUndo({
      message: 'Draft discarded.',
      commit,
      restore,
      undoSlot: { set: (action) => (slot = action), retire },
    })
    slot!()
    expect(restore).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
    expect(slot).toBeUndefined()
  })

  it('takes the shortcut back once the removal is sent', async () => {
    const commitAfterUndo = await load()
    let slot: (() => void) | undefined
    commitAfterUndo({
      message: 'Draft discarded.',
      commit: () => Promise.resolve(),
      restore: vi.fn(),
      undoSlot: {
        set: (action) => (slot = action),
        retire: (action) => slot === action && (slot = undefined),
      },
    })
    shown[0].onAutoClose()
    expect(slot).toBeUndefined()
  })

  it('puts the rows back when the removal fails', async () => {
    const commitAfterUndo = await load()
    const restore = vi.fn()
    commitAfterUndo({
      message: 'Draft discarded.',
      commit: () => Promise.reject(new Error('refused')),
      restore,
    })
    shown[0].onDismiss()
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce())
  })
})
