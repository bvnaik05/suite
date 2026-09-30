<script setup lang="ts">
import './styles.css'
import { copyingDraft, drawingConflict, drawingLoadError, drawingTitle, saveRecoveredCopy } from './canvas/persistence'
import { Button, TextInput } from 'frappe-ui'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import drawLogo from './assets/draw-logo.svg'
import type { DrawingTool } from './canvas/tools'
import DrawingToolbar from './components/DrawingToolbar.vue'
import InfiniteCanvas from './components/InfiniteCanvas.vue'

const title = drawingTitle
const titleDraft = ref(title.value)
const editingTitle = ref(false)
const titleInput = ref<{ el: HTMLInputElement | null } | null>(null)
const activeTool = ref<DrawingTool | null>('select')
let lastTool: DrawingTool = 'select'
const toolShortcuts: Partial<Record<string, DrawingTool>> = {
  r: 'rectangle', d: 'diamond', c: 'ellipse', o: 'ellipse',
  l: 'line', a: 'arrow', t: 'text', i: 'image',
  k: 'laser', p: 'draw', e: 'eraser', 0: 'eraser',
}

function startRenaming() {
  titleDraft.value = title.value
  editingTitle.value = true
  nextTick(() => {
    titleInput.value?.el?.focus()
    titleInput.value?.el?.select()
  })
}

function finishRenaming() {
  if (!editingTitle.value) return
  title.value = titleDraft.value.trim() || 'Untitled Drawing'
  editingTitle.value = false
  nextTick(() => document.querySelector<HTMLElement>('.infinite-canvas')?.focus())
}
function cancelRenaming() { titleDraft.value = title.value; finishRenaming() }
function retryLoad() { location.reload() }

function selectTool(tool: DrawingTool) {
  if (tool === 'eraser' && activeTool.value !== 'eraser') lastTool = activeTool.value ?? 'select'
  activeTool.value = tool
}

function finishTool() {
  activeTool.value = 'select'
}

function cancelTool() {
  activeTool.value = activeTool.value === 'eraser' ? lastTool : 'select'
}

function onToolShortcut(event: KeyboardEvent) {
  if (drawingConflict.value || drawingLoadError.value || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
  const target = event.target instanceof HTMLElement ? event.target : null
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
  const tool = toolShortcuts[event.key.toLowerCase()]
  if (!tool) return
  event.preventDefault()
  selectTool(tool)
}

function isPageZoomShortcut(event: KeyboardEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false
  return ['+', '-', '=', '0', 'Add', 'Subtract'].includes(event.key)
}

function preventPageZoom(event: WheelEvent | KeyboardEvent) {
  if (event instanceof WheelEvent) {
    if (event.ctrlKey || event.metaKey) event.preventDefault()
    return
  }
  if (isPageZoomShortcut(event)) event.preventDefault()
}

function preventPagePinch(event: Event) {
  event.preventDefault()
}

onMounted(() => {
  window.addEventListener('wheel', preventPageZoom, { capture: true, passive: false })
  window.addEventListener('keydown', preventPageZoom, true)
  window.addEventListener('keydown', onToolShortcut, true)
  window.addEventListener('gesturestart', preventPagePinch, { passive: false })
  window.addEventListener('gesturechange', preventPagePinch, { passive: false })
})

onBeforeUnmount(() => {
  window.removeEventListener('wheel', preventPageZoom, true)
  window.removeEventListener('keydown', preventPageZoom, true)
  window.removeEventListener('keydown', onToolShortcut, true)
  window.removeEventListener('gesturestart', preventPagePinch)
  window.removeEventListener('gesturechange', preventPagePinch)
})
</script>

<template>
  <main class="app-shell">
    <header class="drawing-header" aria-label="Drawing header">
      <div class="header-side header-left">
        <RouterLink to="/suite" aria-label="Back to Suite">
          <img class="draw-logo" :src="drawLogo" alt="Draw" width="24" height="24" />
        </RouterLink>
      </div>
      <h1 class="drawing-title">
        <TextInput
          v-if="editingTitle"
          ref="titleInput"
          v-model="titleDraft"
          class="title-field"
          aria-label="Drawing title"
          spellcheck="false"
          variant="outline"
          @blur="finishRenaming"
          @keyup.enter="finishRenaming"
          @keydown.esc.stop.prevent="cancelRenaming"
        />
        <button
          v-else
          class="title-button"
          type="button"
          aria-label="Rename drawing"
          :disabled="drawingConflict || drawingLoadError"
          @click="startRenaming"
        >
          {{ title }}
        </button>
      </h1>
    </header>
    <DrawingToolbar :active-tool="activeTool" :inert="drawingConflict || drawingLoadError" @select="selectTool" />
    <InfiniteCanvas
      :active-tool="activeTool"
      :inert="drawingConflict || drawingLoadError"
      @cancel-tool="cancelTool"
      @shape-created="finishTool"
    />
    <div v-if="drawingConflict || drawingLoadError" class="drawing-recovery" role="alert">
      <div v-if="drawingConflict" class="drawing-recovery-card">
        <p>The saved drawing changed since this draft. Save the draft as a new drawing to continue editing.</p>
        <Button variant="solid" label="Save recovered copy" :disabled="copyingDraft" @click="saveRecoveredCopy" />
      </div>
      <div v-else class="drawing-recovery-card">
        <p>Could not load this drawing. Check your connection and permissions, then retry.</p>
        <Button label="Retry" @click="retryLoad" />
      </div>
    </div>
  </main>
</template>
