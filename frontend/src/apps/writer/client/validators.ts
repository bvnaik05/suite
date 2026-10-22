// Generated from src/apps/writer/client/contract.json. Do not edit.
import type { Validators } from '@/platform/transport'
import { assertSchema } from '@/platform/transport/schema'

import type {
  ConvertVersionInput,
  ConvertVersionOutput,
  DocumentInput,
  DocumentOutput,
  SaveCommentsInput,
  SaveCommentsOutput,
  SaveDocInput,
  SaveDocOutput,
  SaveHtmlInput,
  SaveHtmlOutput,
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
        },
        required: ['name'],
        title: 'WriterRow',
        type: 'object',
      },
      'document output',
    )
  },
}

export const operationSaveDoc: Validators<SaveDocInput, SaveDocOutput> = {
  validateInput(value: unknown): asserts value is SaveDocInput {
    assertSchema(
      value,
      {
        type: 'object',
        properties: {
          data: { title: 'Data', type: 'string' },
          html: { title: 'Html', type: 'string' },
          name: { type: 'string' },
        },
        required: ['data', 'name'],
        additionalProperties: false,
        $defs: {},
      },
      'save_doc input',
    )
  },
  validateOutput(value: unknown): asserts value is SaveDocOutput {
    assertSchema(value, { type: 'null' }, 'save_doc output')
  },
}

export const operationSaveHtml: Validators<SaveHtmlInput, SaveHtmlOutput> = {
  validateInput(value: unknown): asserts value is SaveHtmlInput {
    assertSchema(
      value,
      {
        type: 'object',
        properties: { html: { title: 'Html', type: 'string' }, name: { type: 'string' } },
        required: ['html', 'name'],
        additionalProperties: false,
        $defs: {},
      },
      'save_html input',
    )
  },
  validateOutput(value: unknown): asserts value is SaveHtmlOutput {
    assertSchema(value, { type: 'null' }, 'save_html output')
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

export const operationSaveComments: Validators<SaveCommentsInput, SaveCommentsOutput> = {
  validateInput(value: unknown): asserts value is SaveCommentsInput {
    assertSchema(
      value,
      {
        type: 'object',
        properties: {
          doc: { title: 'Doc', type: 'string' },
          data: { title: 'Data', type: 'string' },
        },
        required: ['doc', 'data'],
        additionalProperties: false,
        $defs: {},
      },
      'save_comments input',
    )
  },
  validateOutput(value: unknown): asserts value is SaveCommentsOutput {
    assertSchema(value, { type: 'null' }, 'save_comments output')
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
