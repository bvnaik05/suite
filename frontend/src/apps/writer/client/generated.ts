// Generated from src/apps/writer/client/contract.json. Do not edit.
import type { MutationRef, PageRef, QueryRef } from '@/platform/transport'

export type DocumentOutputConversionStatus = {
  state: string
  reason?: string
  rooms?: DocumentOutputRooms
}

export type DocumentOutputRooms = {
  epoch: number
  keys: Array<string>
  epoch_seconds: number
  server_time: number
}

export type DocumentInput = { name: string }

export type DocumentOutput = {
  name: string
  collab?: number
  content?: string | null
  html?: string | null
  ycomments?: string | null
  settings?: string | { [key: string]: unknown } | null
  conversion?: DocumentOutputConversionStatus
  content_modified?: string
}

export type DocumentError = never

const operationDocument: QueryRef<DocumentInput, DocumentOutput, DocumentError> = {
  id: 'document',
  owner: 'writer',
  kind: 'query',
  publicName: 'documents.get',
  method: 'GET',
  path: '/api/v2/document/Writer Document/{name}',
  prefix: '/api/suite/writer/',
  pathParams: ['name'],
  nodeParams: [],
  entity: null,
  errors: [],
  loadValidators: async () => (await import('./validators')).operationDocument,
}

export type UpdateSettingsInput = { data: string; name: string }

export type UpdateSettingsOutput = null

export type UpdateSettingsError = never

const operationUpdateSettings: MutationRef<
  UpdateSettingsInput,
  UpdateSettingsOutput,
  UpdateSettingsError
> = {
  id: 'update_settings',
  owner: 'writer',
  kind: 'mutation',
  publicName: 'documents.updateSettings',
  empty: true,
  method: 'POST',
  path: '/api/v2/document/Writer Document/{name}/method/update_settings',
  prefix: '/api/suite/writer/',
  pathParams: ['name'],
  nodeParams: [],
  entity: null,
  errors: [],
  loadValidators: async () => (await import('./validators')).operationUpdateSettings,
}

export type OldBodyInput = { node: string }

export type OldBodyOutput = { content?: string }

export type OldBodyError = never

const operationOldBody: QueryRef<OldBodyInput, OldBodyOutput, OldBodyError> = {
  id: 'old_body',
  owner: 'writer',
  kind: 'query',
  publicName: 'documents.oldBody',
  method: 'GET',
  path: '/api/v2/method/suite.writer.api.docs.old_body',
  prefix: '/api/suite/writer/',
  pathParams: [],
  nodeParams: [],
  entity: null,
  errors: [],
  loadValidators: async () => (await import('./validators')).operationOldBody,
}

export type ConvertVersionInput = { node: string; seq: number }

export type ConvertVersionOutput = { state?: string; reason?: string; pending?: boolean }

export type ConvertVersionError = never

const operationConvertVersion: MutationRef<
  ConvertVersionInput,
  ConvertVersionOutput,
  ConvertVersionError
> = {
  id: 'convert_version',
  owner: 'writer',
  kind: 'mutation',
  publicName: 'versions.convert',
  method: 'POST',
  path: '/api/v2/method/suite.writer.api.docs.convert_version',
  prefix: '/api/suite/writer/',
  pathParams: [],
  nodeParams: [],
  entity: null,
  errors: [],
  loadValidators: async () => (await import('./validators')).operationConvertVersion,
}

export const api = {
  documents: {
    get: operationDocument,
    updateSettings: operationUpdateSettings,
    oldBody: operationOldBody,
  },
  versions: {
    convert: operationConvertVersion,
  },
} as const
