import { defineComponent, h } from 'vue'

import type { DocumentTypeDefinition } from '@/platform/contracts'
import { translate as __ } from '@/platform/translation'

const DrawIcon = defineComponent({
  name: 'DrawDocumentIcon',
  setup: () => () => h('span', { class: 'lucide-pencil-ruler size-4', 'aria-hidden': 'true' }),
})

export const drawDocument: DocumentTypeDefinition = {
  key: 'draw',
  contentDoctype: 'Drawing',
  newLabel: () => __('Drawing'),
  icon: DrawIcon,
  loadSurface: async () => (await import('./surface/DrawSurface.vue')).default,
}
