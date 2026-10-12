import type { ContentAdapter } from '@suite/collab-client'

import { caretPosition } from '@/apps/writer/collab/carets'

import features from '../../../../../suite/writer/content/features.json'

export const writerAdapter: ContentAdapter = {
  features,
  position: caretPosition,
}
