<script setup lang="ts">
import { computed } from 'vue'
import { bounds, isDiamond, isEllipse, isFreeDraw, isImage, isLine, isText, type Shape } from '../canvas/selection'
import { diamondPath, freeDrawPath } from '../canvas/scene'

const props = defineProps<{ shapes: Shape[] }>()
const viewBox = computed(() => {
  const box = bounds(props.shapes)
  if (!box) return '0 0 800 450'
  const width = Math.max(box.width * 1.35, box.height * 2.4, 200)
  const height = width * 9 / 16
  return `${box.x + box.width / 2 - width / 2} ${box.y + box.height / 2 - height / 2} ${width} ${height}`
})
</script>

<template>
  <svg :viewBox="viewBox" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <g v-for="shape in shapes" :key="shape.id" :opacity="shape.opacity ?? 1">
      <path v-if="isLine(shape)" :d="`M ${shape.start.x} ${shape.start.y} L ${shape.end.x} ${shape.end.y}`" fill="none" :stroke="shape.stroke || '#222'" :stroke-width="shape.strokeWidth ?? 2" />
      <path v-else-if="isFreeDraw(shape)" :d="freeDrawPath(shape)" fill="none" :stroke="shape.stroke || '#222'" :stroke-width="shape.strokeWidth ?? 2" />
      <path v-else-if="isDiamond(shape)" :d="diamondPath(shape)" :fill="shape.fill || 'none'" :stroke="shape.stroke || '#222'" :stroke-width="shape.strokeWidth ?? 2" />
      <ellipse v-else-if="isEllipse(shape)" :cx="shape.x + shape.width / 2" :cy="shape.y + shape.height / 2" :rx="shape.width / 2" :ry="shape.height / 2" :fill="shape.fill || 'none'" :stroke="shape.stroke || '#222'" :stroke-width="shape.strokeWidth ?? 2" />
      <image v-else-if="isImage(shape)" :href="shape.src" :x="shape.x" :y="shape.y" :width="shape.width" :height="shape.height" />
      <text v-else-if="isText(shape)" :x="shape.x" :y="shape.y + shape.fontSize" :font-size="shape.fontSize" :fill="shape.fill || '#222'">{{ shape.text }}</text>
      <rect v-else :x="shape.x" :y="shape.y" :width="shape.width" :height="shape.height" :rx="shape.cornerRadius" :fill="shape.fill || 'none'" :stroke="shape.stroke || '#222'" :stroke-width="shape.strokeWidth ?? 2" />
    </g>
  </svg>
</template>
