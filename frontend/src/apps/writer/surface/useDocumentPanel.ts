import { toast } from 'frappe-ui'
import { reactive } from 'vue'

import type { DocumentPanel, DocumentSession, DocumentThread, DocumentVersion } from '@/apps/drive'

type PanelSession = Pick<DocumentSession, 'comments' | 'versions'>

interface PanelLists {
  threads: DocumentThread[]
  versions: DocumentVersion[]
  versionsCursor: string | null
  isLoading: boolean
  isLoadingMore: boolean
}

export function versionLabel(version: DocumentVersion) {
  return version.label || `Version ${version.seq}`
}

function showError(error: unknown, fallback: string) {
  if (error instanceof Error) {
    toast.error(error.message)
    return
  }

  toast.error(fallback)
}

async function loadPanel(session: PanelSession, lists: PanelLists, kind: DocumentPanel) {
  lists.isLoading = true
  try {
    if (kind === 'comments') {
      lists.threads = (await session.comments.list()).threads
    } else {
      const page = await session.versions.list()
      lists.versions = page.rows
      lists.versionsCursor = page.next_cursor
    }
  } catch (error) {
    showError(error, 'Could not load this panel.')
  } finally {
    lists.isLoading = false
  }
}

async function loadMoreVersions(session: PanelSession, lists: PanelLists) {
  if (!lists.versionsCursor) {
    return
  }

  lists.isLoadingMore = true
  try {
    const page = await session.versions.list(lists.versionsCursor)
    lists.versions = [...lists.versions, ...page.rows]
    lists.versionsCursor = page.next_cursor
  } catch (error) {
    // A failed next page keeps the rows already shown
    showError(error, 'Could not load more versions.')
  } finally {
    lists.isLoadingMore = false
  }
}

// Whether the comment went in; the list is read again after it does
async function addComment(
  session: PanelSession,
  lists: PanelLists,
  text: string,
  authorName?: string,
) {
  try {
    await session.comments.create('document', text, authorName)
  } catch (error) {
    showError(error, 'Could not add the comment.')
    return false
  }

  await loadPanel(session, lists, 'comments')
  return true
}

// Whether the version was taken; `saveFirst` saves the tab's edits and throws why it couldn't
async function saveVersion(
  session: PanelSession,
  lists: PanelLists,
  label: string,
  saveFirst: () => Promise<void>,
) {
  try {
    await saveFirst()
    await session.versions.create('named', label)
  } catch (error) {
    showError(error, 'Could not save a version.')
    return false
  }

  toast.success('Version saved')
  await loadPanel(session, lists, 'versions')
  return true
}

// The side panel's comments and versions, loaded when the panel opens
export function useDocumentPanel(session: PanelSession) {
  const lists = reactive<PanelLists>({
    threads: [],
    versions: [],
    versionsCursor: null,
    isLoading: false,
    isLoadingMore: false,
  })
  return {
    lists,
    load: (kind: DocumentPanel) => loadPanel(session, lists, kind),
    loadMoreVersions: () => loadMoreVersions(session, lists),
    addComment: (text: string, authorName?: string) => addComment(session, lists, text, authorName),
    saveVersion: (label: string, saveFirst: () => Promise<void>) =>
      saveVersion(session, lists, label, saveFirst),
  }
}
