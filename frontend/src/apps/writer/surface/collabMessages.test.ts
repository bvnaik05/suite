import { describe, expect, it } from 'vitest'

import {
  bannerFor,
  openFailureFor,
  refusedSaveBanner,
  type Banner,
  type BannerState,
} from './collabMessages'

// What the banner reads on the page, with the link standing for its words
function pageText(banner: Banner | null) {
  if (!banner) return banner

  const link = banner.link ? `[${banner.link.label}]` : ''
  return `${banner.text}${link}${banner.after ?? ''}`
}

const defaultState = {
  blocked: null,
  stopped: null,
  held: null,
  restoring: false,
  newerSchema: false,
  canEdit: true,
  paused: null,
  failed: false,
  atLimit: false,
  onDevice: true,
  recoveryKept: false,
  copyFailed: false,
  setAside: null,
  isNewerAfterReload: false,
  unsent: 1,
  polling: false,
  isFrozen: false,
} as const

// What the banner reads for a room that differs from the default state in `changes`
function bannerText(changes: Partial<BannerState>) {
  const changed = { ...defaultState, ...changes }
  const banner = bannerFor(changed)
  return pageText(banner)
}

describe('collab banner copy', () => {
  it('tells an old editor its save was refused, where its work went, and to reload', () => {
    expect([refusedSaveBanner(true).text, refusedSaveBanner(false).text]).toEqual([
      'This document now saves as you edit, so saving stopped in this tab. Unsent changes were kept as a recovery copy. Reload to keep editing.',
      'This document now saves as you edit, so saving stopped in this tab. Reload to keep editing.',
    ])
  })

  it("says a signed-out tab isn't saving and asks to sign in", () => {
    expect(bannerText({ blocked: 'signed_out' })).toBe(
      "You're signed out, so changes aren't saved. [Sign in] to save them.",
    )
    expect(bannerText({ blocked: 'signed_out', onDevice: false })).toBe(
      "You're signed out, so changes aren't saved. [Sign in] to save them. Keep this tab open.",
    )
  })

  it("doesn't speak of unsaved changes when nothing is unsent", () => {
    for (const onDevice of [true, false]) {
      expect(bannerText({ blocked: 'signed_out', onDevice, unsent: 0 })).toBe(
        "You're signed out. [Sign in] to keep editing.",
      )
    }
  })

  it("says a locked document isn't saving", () => {
    expect(bannerText({ blocked: 'locked' })).toBe(
      "This document was locked, so changes aren't saved. Unlock it to save them.",
    )
    expect(bannerText({ blocked: 'locked', onDevice: false })).toBe(
      "This document was locked, so changes aren't saved. Unlock it to save them. Keep this tab open.",
    )
  })

  it("pauses editing offline when the browser can't keep changes", () => {
    expect(bannerText({ blocked: 'offline', onDevice: false })).toBe(
      "You're offline and this browser can't keep changes, so editing is paused.",
    )
  })

  it('asks for a reload after signing in again elsewhere', () => {
    expect(bannerText({ blocked: 'stale_session' })).toBe(
      'You signed in again in another tab. Reload to keep saving.',
    )
    expect(bannerText({ blocked: 'stale_session', onDevice: false, recoveryKept: true })).toBe(
      'You signed in again in another tab. Unsent changes were kept as a recovery copy. Reload to keep saving.',
    )
  })

  it("tells whether another person's sign-in kept the unsent changes", () => {
    expect(bannerText({ blocked: 'other_user' })).toBe(
      'Someone else is now signed in here. Your unsent changes are kept on this device.',
    )
    expect(bannerText({ blocked: 'other_user', onDevice: false })).toBe(
      'Someone else is now signed in here. Reload to continue.',
    )
    expect(bannerText({ blocked: 'other_user', onDevice: false, recoveryKept: true })).toBe(
      'Someone else is now signed in here. Unsent changes were kept as a recovery copy. Reload to continue.',
    )
  })

  it('never claims a recovery copy the device could not write, and asks to keep the tab open', () => {
    expect(bannerText({ failed: true, stopped: 'seq', copyFailed: true })).toBe(
      "Saving stopped in this tab. Unsent changes couldn't be kept on this device, so keep this tab open. Reload to keep editing.",
    )
    expect(bannerText({ blocked: 'lost_edit', copyFailed: true })).toBe(
      "You can no longer edit this document. Unsent changes couldn't be kept on this device, so keep this tab open.",
    )
  })

  it('names the recovery copy after a lost right or a stop', () => {
    expect(bannerText({ blocked: 'lost_edit', recoveryKept: true })).toBe(
      'You can no longer edit this document. Unsent changes were kept as a recovery copy.',
    )
    expect(bannerText({ blocked: 'lost_read' })).toBe('You can no longer open this document.')
    expect(bannerText({ failed: true, recoveryKept: true })).toBe(
      'Saving stopped in this tab. Unsent changes were kept as a recovery copy. Reload to keep editing.',
    )
  })
})

describe('collab stop copy', () => {
  it('says why the server will never save a change', () => {
    expect(bannerText({ failed: true, stopped: 'poison', recoveryKept: true })).toBe(
      "This document can't hold a change made in this tab, so saving stopped. Unsent changes were kept as a recovery copy. Reload to keep editing.",
    )
  })

  it('says a change too large to save should go in as files', () => {
    expect(bannerText({ failed: true, stopped: 'too_large', recoveryKept: true })).toBe(
      'A change in this tab is too large to save. Insert large images as files. Unsent changes were kept as a recovery copy. Reload to keep editing.',
    )
  })

  it('says a change a full document refused could not be saved, and where it went', () => {
    expect(bannerText({ failed: true, stopped: 'document_full', recoveryKept: true })).toBe(
      "This document is at its size limit, so a change in this tab couldn't be saved. Unsent changes were kept as a recovery copy. Reload to keep editing.",
    )
  })

  it('says saving stopped because a newer Writer edited the document, and where the unsent work went', () => {
    expect(bannerText({ failed: true, stopped: 'schema', recoveryKept: true })).toBe(
      'This document was edited in a newer version of Writer, so saving stopped in this tab. Unsent changes were kept as a recovery copy. Reload to keep editing.',
    )
  })

  it('says saving stopped because collaboration was switched off, and where the unsent work went', () => {
    expect(bannerText({ failed: true, stopped: 'disabled', recoveryKept: true })).toBe(
      'Collaboration was switched off for this app, so saving stopped in this tab. Unsent changes were kept as a recovery copy. Reload to keep editing.',
    )
  })

  it('says a document at its size limit frees space as content is deleted, and where the latest changes went', () => {
    expect(bannerText({ atLimit: true })).toBe(
      'This document is at its size limit. Delete content to free space.',
    )
    expect(bannerText({ atLimit: true, setAside: 'document_full' })).toBe(
      'This document is at its size limit. Your latest changes went to a recovery copy. Delete content to free space.',
    )
  })

  it('says nothing while saving goes on, unless an earlier room set edits aside', () => {
    expect(bannerFor(defaultState)).toBeNull()
    expect(bannerText({ setAside: 'poison' })).toBe(
      "Your last edits couldn't be saved here and were kept as a recovery copy.",
    )
  })

  it('says a restore stopped the work typed before it, and where it went', () => {
    expect(bannerText({ stopped: 'restored', failed: true, recoveryKept: true })).toBe(
      "A version of this document was restored, so changes made in this tab before it weren't saved. Unsent changes were kept as a recovery copy. Reload to keep editing.",
    )
  })

  it('says a network refusing uploads is holding the latest changes back, and where they are', () => {
    expect(bannerText({ paused: 'upload_refused' })).toBe(
      "Your network is refusing uploads, so your latest changes aren't saved. They're kept on this device.",
    )
    expect(bannerText({ paused: 'upload_refused', onDevice: false })).toBe(
      "Your network is refusing uploads, so your latest changes aren't saved. Keep this tab open.",
    )
  })

  it('says editing is paused to keep a document safe that this tab cannot show, and offers Reload', () => {
    const banner = bannerFor({ ...defaultState, isFrozen: true })

    expect([banner?.text, banner?.canReload]).toEqual([
      "Part of this document can't be shown here, so editing is paused to keep it safe.",
      true,
    ])
  })

  it('shows a stop over a tab that cannot show the document, and the freeze over a wait', () => {
    const frozen = { isFrozen: true }
    const frozenText =
      "Part of this document can't be shown here, so editing is paused to keep it safe."

    expect([
      bannerText({ ...frozen, failed: true }),
      bannerText({ ...frozen, failed: true, stopped: 'browser' }),
      bannerText({ ...frozen, blocked: 'locked' }),
      bannerText({ ...frozen, held: 'change' }),
      bannerText({ ...frozen, polling: true }),
    ]).toEqual([
      'Saving stopped in this tab. Reload to keep editing.',
      "This document can't be edited in this browser version.",
      "This document was locked, so changes aren't saved. Unlock it to save them.",
      frozenText,
      frozenText,
    ])
  })

  it('does not offer a reload for a stop a reload would only repeat', () => {
    expect(bannerText({ failed: true, stopped: 'browser', recoveryKept: true })).toBe(
      "This document can't be edited in this browser version. Unsent changes were kept as a recovery copy.",
    )
  })

  it('says a held document is read-only while an admin checks it, and where the typing is', () => {
    expect(bannerText({ held: 'change' })).toBe(
      "This document is read-only while an admin checks it. Your unsent changes are saved on this device and will be added once it's editable again.",
    )
    expect(bannerText({ held: 'change', onDevice: false })).toBe(
      "This document is read-only while an admin checks it. Your unsent changes will be added once it's editable again. Keep this tab open.",
    )
    expect(bannerText({ held: 'change', unsent: 0 })).toBe(
      'This document is read-only while an admin checks it.',
    )
  })

  it('says editing waits while a version is restored', () => {
    expect(bannerText({ restoring: true, paused: 'restoring' })).toBe(
      'Someone is restoring a version of this document. You can edit again once it is done.',
    )
  })

  it('says the same when the whole document is held as when one change is', () => {
    expect(bannerText({ held: 'bad_checkpoint', unsent: 0 })).toBe(
      'This document is read-only while an admin checks it.',
    )
  })

  it('stops asking for a reload once a reload brought back the same Writer', () => {
    const fallback =
      'This document needs a newer version of Writer than this site has. Try again in a few minutes, or ask your admin.'
    expect([
      bannerText({ newerSchema: true, isNewerAfterReload: true }),
      bannerText({ newerSchema: true, isNewerAfterReload: true, canEdit: false, unsent: 0 }),
    ]).toEqual([fallback, fallback])
  })

  it('asks for a reload when a newer Writer edited the document', () => {
    expect(bannerText({ newerSchema: true })).toBe(
      'This document was edited in a newer version of Writer. Reload to edit it.',
    )
  })

  it('asks a reader to reload to see the changes, not to edit', () => {
    expect(bannerText({ newerSchema: true, canEdit: false, unsent: 0 })).toBe(
      'This document was edited in a newer version of Writer. Reload to see its latest changes.',
    )
  })

  it('says live updates are unavailable while the tab polls, unless something says more', () => {
    expect(bannerText({ polling: true })).toBe(
      "Live updates are unavailable, so others' changes show up late.",
    )
    expect(bannerText({ polling: true, blocked: 'locked' })).toBe(
      "This document was locked, so changes aren't saved. Unlock it to save them.",
    )
    expect(bannerText({ polling: true, atLimit: true })).toBe(
      'This document is at its size limit. Delete content to free space.',
    )
  })

  it('keeps the general copy for a stop it has no words for', () => {
    for (const stopped of ['seq_conflict', 'constructor']) {
      expect(bannerText({ failed: true, stopped })).toBe(
        'Saving stopped in this tab. Reload to keep editing.',
      )
    }
  })
})

describe('collab open failure copy', () => {
  it("says why the document didn't open and what to do", () => {
    expect(openFailureFor('signed_out')).toBe("You're signed out. Sign in to open this document.")
    expect(openFailureFor('locked')).toBe('This document is locked. Unlock it to open it.')
    expect(openFailureFor('stale_session')).toBe(
      'You signed in again in another tab. Reload to open this.',
    )
    expect(openFailureFor('principal_changed')).toBe(
      'Someone else is now signed in here. Reload to open this document.',
    )
  })

  it("names a failure the reply's status explains", () => {
    expect(openFailureFor(null, 0)).toBe(
      "Couldn't reach the server. Check your connection and try again.",
    )
    expect(openFailureFor(null, 500)).toBe(
      'The server had a problem opening this document. Try again in a moment.',
    )
    expect(openFailureFor(null, 503)).toBe(
      'The server had a problem opening this document. Try again in a moment.',
    )
    expect(openFailureFor(null, 429)).toBe('The server is busy. Try again in a moment.')
    expect(openFailureFor(null, 400)).toBe("This document couldn't be opened.")
    expect(openFailureFor(null, null)).toBe("This document couldn't be opened.")
    expect(openFailureFor('locked', 500)).toBe('This document is locked. Unlock it to open it.')
  })
})
