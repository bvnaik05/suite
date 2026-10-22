// Generated from src/apps/writer/client/contract.json. Do not edit.
import type { Validators } from '@/platform/transport'
import { assertSchema } from '@/platform/transport/schema'

import type {
  ConvertVersionInput,
  ConvertVersionOutput,
  DocumentInput,
  DocumentOutput,
  OldBodyInput,
  OldBodyOutput,
  UpdateSettingsInput,
  UpdateSettingsOutput,
} from './generated'

export const operationDocument: Validators<DocumentInput, DocumentOutput> = {
  validateInput(value: unknown): asserts value is DocumentInput {
    assertSchema(
      value,
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
        $defs: {},
      },
      'document input',
    )
  },
  validateOutput(value: unknown): asserts value is DocumentOutput {
    assertSchema(
      value,
      {
        $defs: {
          ConversionStatus: {
            properties: {
              state: { title: 'State', type: 'string' },
              reason: { title: 'Reason', type: 'string' },
            },
            required: ['state'],
            title: 'ConversionStatus',
            type: 'object',
          },
        },
        properties: {
          name: { title: 'Name', type: 'string' },
          collab: { title: 'Collab', type: 'integer' },
          content: { anyOf: [{ type: 'string' }, { type: 'null' }], title: 'Content' },
          html: { anyOf: [{ type: 'string' }, { type: 'null' }], title: 'Html' },
          ycomments: { anyOf: [{ type: 'string' }, { type: 'null' }], title: 'Ycomments' },
          settings: {
            anyOf: [
              { type: 'string' },
              { additionalProperties: true, type: 'object' },
              { type: 'null' },
            ],
            title: 'Settings',
          },
          conversion: { $ref: '#/$defs/ConversionStatus' },
          content_modified: { title: 'Content Modified', type: 'string' },
        },
        required: ['name'],
        title: 'WriterRow',
        type: 'object',
      },
      'document output',
    )
  },
}

export const operationUpdateSettings: Validators<UpdateSettingsInput, UpdateSettingsOutput> = {
  validateInput(value: unknown): asserts value is UpdateSettingsInput {
    assertSchema(
      value,
      {
        type: 'object',
        properties: { data: { title: 'Data', type: 'string' }, name: { type: 'string' } },
        required: ['data', 'name'],
        additionalProperties: false,
        $defs: {},
      },
      'update_settings input',
    )
  },
  validateOutput(value: unknown): asserts value is UpdateSettingsOutput {
    assertSchema(value, { type: 'null' }, 'update_settings output')
  },
}

export const operationOldBody: Validators<OldBodyInput, OldBodyOutput> = {
  validateInput(value: unknown): asserts value is OldBodyInput {
    assertSchema(
      value,
      {
        type: 'object',
        properties: { node: { title: 'Node', type: 'string' } },
        required: ['node'],
        additionalProperties: false,
        $defs: {},
      },
      'old_body input',
    )
  },
  validateOutput(value: unknown): asserts value is OldBodyOutput {
    assertSchema(
      value,
      {
        properties: { content: { title: 'Content', type: 'string' } },
        title: 'OldBody',
        type: 'object',
      },
      'old_body output',
    )
  },
}

export const operationConvertVersion: Validators<ConvertVersionInput, ConvertVersionOutput> = {
  validateInput(value: unknown): asserts value is ConvertVersionInput {
    assertSchema(
      value,
      {
        type: 'object',
        properties: {
          node: { title: 'Node', type: 'string' },
          seq: { title: 'Seq', type: 'integer' },
        },
        required: ['node', 'seq'],
        additionalProperties: false,
        $defs: {},
      },
      'convert_version input',
    )
  },
  validateOutput(value: unknown): asserts value is ConvertVersionOutput {
    assertSchema(
      value,
      {
        properties: {
          state: { title: 'State', type: 'string' },
          reason: { title: 'Reason', type: 'string' },
        },
        title: 'VersionConversion',
        type: 'object',
      },
      'convert_version output',
    )
  },
}
