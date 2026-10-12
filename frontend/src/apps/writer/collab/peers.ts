import type { Peer } from '@suite/collab-client'

import { fullName, lookUp } from '@/apps/writer/composables/useUsers'

// A guest is named by its tab, so two guests in one document read apart
export function peerName(user: string, peerId: number) {
  if (user === 'Guest') {
    return `Guest ${peerId.toString(36).slice(-4).toUpperCase()}`
  }

  return fullName(user)
}

// Calls `named` once a signed-in person's full name has been looked up; a guest's name never changes
export function whenNamed(user: string, named: () => void) {
  if (user !== 'Guest') {
    void lookUp(user).then(named)
  }
}

// One entry per person; every guest tab is its own person
export function peopleOf(peers: Peer[]) {
  const seen = new Set<string>()
  const newPerson = (peer: Peer) => {
    const key = peer.user === 'Guest' ? `${peer.pid}` : peer.user
    if (seen.has(key)) {
      return []
    }

    seen.add(key)
    const person = {
      clientId: peer.pid,
      id: peer.user,
      name: peerName(peer.user, peer.pid),
      color: peer.color,
    }
    return [person]
  }
  return peers.flatMap(newPerson)
}
