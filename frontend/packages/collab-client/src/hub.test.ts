import { afterEach, describe, expect, it, vi } from 'vitest'

import { Hub } from './hub'
import type { LiveSocket } from './types'

function memberWith(keys: { current: string[] }) {
  return {
    currentKeys: () => keys.current,
    connected: () => {},
    dropped: () => {},
    answered: () => {},
  }
}

function roomKeys(count: number) {
  return Array.from({ length: count }, (_, index) => `sc:room-${index}`)
}

describe('Hub', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns once each time the room count goes over the cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const socket: LiveSocket = { connected: true, on: () => {}, off: () => {}, emit: () => {} }
    const hub = Hub.forSocket(socket)
    const keys = { current: roomKeys(9) }
    hub.members.add(memberWith(keys))

    hub.sendRoomSet()
    keys.current = roomKeys(10)
    hub.sendRoomSet()
    expect(warn).toHaveBeenCalledTimes(1)

    keys.current = roomKeys(3)
    hub.sendRoomSet()
    keys.current = roomKeys(9)
    hub.sendRoomSet()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
