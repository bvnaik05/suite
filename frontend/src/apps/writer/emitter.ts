import mitt, { type EventType } from 'mitt'

interface WriterEvents extends Record<EventType, unknown> {
  'print-file': undefined
  'manual-save': () => void
}

const emitter = mitt<WriterEvents>()
export default emitter
