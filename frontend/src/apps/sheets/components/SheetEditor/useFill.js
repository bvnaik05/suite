import { planFill } from '../../engine/fill-series.js'
import { adjustFormula } from '../../engine/formula-adjust.js'
import { detectSeries } from '../../engine/patterns/index.js'
import { cellId } from '../../utils/cells.js'

// Fill, extracted from SheetEditor/index.vue: the drag fill handle (series /
// copy / formats-only, with validation, conditional-format rules and merges
// following the values) and Ctrl+D / Ctrl+R. Each fill is recorded as one
// undo step and one op for the version log.
//
// The editor passes its helpers under their own names; the `_names` are kept
// here so the code reads as it did in index.vue.
export function useFill({
  getGrid,
  currentSheet,
  formats,
  merge,
  validation,
  condFormat,
  history,
  isDirty,
  syncFlags,
  markEdited,
  readInputs: _readInputs,
  writeInputs: _writeInputs,
  captureFormatsRange: _captureFormatsRange,
  captureValidationRange: _captureValidationRange,
  diffRefs: _diffRefs,
  queueOp: _queueOp,
  rectBlocked: _rectBlocked,
  pushEditOp: _pushEditOp,
}) {
  function _fillValidation(src, total, sn) {
    const srcRows = src.r1 - src.r0 + 1,
      srcCols = src.c1 - src.c0 + 1
    for (let r = total.r0; r <= total.r1; r++) {
      for (let c = total.c0; c <= total.c1; c++) {
        if (r >= src.r0 && r <= src.r1 && c >= src.c0 && c <= src.c1) continue
        const srcR = src.r0 + ((r - src.r0 + srcRows) % srcRows)
        const srcC = src.c0 + ((c - src.c0 + srcCols) % srcCols)
        const rule = validation.get(cellId(srcR, srcC), sn)
        if (rule) validation.set(cellId(r, c), rule, sn)
      }
    }
  }

  // _runFill modes: 'auto' | 'series' | 'copy' | 'format-only' | 'without-format'
  async function _runFill(src, total, mode) {
    const sheetName = currentSheet.value
    // `total` includes `src`, so this one read is also the fill's source.
    const fillBefore = await _readInputs(total, sheetName)
    const beforeFmt = _captureFormatsRange(total, sheetName)
    const beforeVal = _captureValidationRange(total, sheetName)
    const beforeMergeSnap = merge.snapshot?.()
    const cfBefore = condFormat?.getRules?.(sheetName)?.length ?? 0
    let writes = {}
    if (mode === 'format-only') {
      _fillFormatsOnly(src, total, sheetName)
    } else {
      const valueMode = mode === 'without-format' ? 'auto' : mode
      writes = planFill(src, total, (r, c) => fillBefore[cellId(r, c)] ?? '', valueMode)
      _writeInputs(sheetName, writes)
      if (mode === 'without-format') _clearFormats(src, total, sheetName)
    }
    if (mode !== 'format-only') {
      _fillValidation(src, total, sheetName)
      condFormat.extendRulesToRange(src, total, sheetName)
    }
    // Merges are a structural format — replicate them alongside cell formats
    // (so a merged source tiles its merge into every dragged-over destination)
    // EXCEPT when the user explicitly asked for values-only with `without-format`.
    if (mode !== 'without-format') {
      _fillMerges(src, total, sheetName)
    }
    const fillAfter = { ...fillBefore, ...writes }
    const afterFmt = _captureFormatsRange(total, sheetName)
    const afterVal = _captureValidationRange(total, sheetName)
    const afterMergeSnap = merge.snapshot?.()
    const cfAfter = condFormat?.getRules?.(sheetName)?.length ?? 0
    const refs = _diffRefs(fillBefore, fillAfter)
    // Server sync — queue the value diff regardless of how history records it.
    if (refs.length) {
      _queueOp({
        opType: 'fill',
        subSheet: sheetName,
        cellRefs: refs,
        before: fillBefore,
        after: fillAfter,
        summary: _fillSummary(mode, refs.length),
      })
    }
    // History — the previous markEdited() path pushed a full snapshot, but
    // history.undo() can't roll a snapshot back when its preceding entry is
    // an op (no earlier snapshot to restore from), so undoing a fill that
    // came after cell edits silently no-op'd the fill and started peeling
    // off the prior cell edits instead — that's the "1, 2 drag-fill to 7,
    // undo clears A2 first" report. The op-based path mirrors paste's
    // shape, which the history's revertOp already round-trips correctly.
    const mergeChanged = JSON.stringify(beforeMergeSnap) !== JSON.stringify(afterMergeSnap)
    const cfChanged = cfBefore !== cfAfter
    if (refs.length && !cfChanged) {
      history.pushOp({
        opType: 'fill',
        subSheet: sheetName,
        cellRefs: refs,
        before: fillBefore,
        after: fillAfter,
        beforeFormats: beforeFmt,
        afterFormats: afterFmt,
        beforeValidation: beforeVal,
        afterValidation: afterVal,
        // Merge restore rides on the same op shape now — revertOp/applyOp
        // call merge.restore when these are present.
        ...(mergeChanged
          ? {
              beforeMerge: beforeMergeSnap,
              afterMerge: afterMergeSnap,
            }
          : {}),
      })
      syncFlags()
      isDirty.value = true
    } else {
      // Conditional-format rules changed — the op shape doesn't model
      // rule restore yet, so fall back to a snapshot. Same snap-after-op
      // edge case applies but only in this narrow path.
      markEdited()
    }
  }
  function _fillSummary(mode, n) {
    if (mode === 'copy') return `Copied into ${n} cell${n === 1 ? '' : 's'}`
    if (mode === 'format-only') return `Filled formats into ${n} cell${n === 1 ? '' : 's'}`
    if (mode === 'without-format') return `Filled (no format) ${n} cell${n === 1 ? '' : 's'}`
    return `Filled ${n} cell${n === 1 ? '' : 's'}`
  }

  // Replicate every merge whose master AND span lie entirely inside `src` into
  // each tile of the destination range. Without this, dragging the fill handle
  // from a merged source produced unmerged target cells — values copied but
  // the structural merge was lost. merge.merge() already unmerges any
  // overlapping merge on the target, so re-runs are idempotent.
  function _fillMerges(src, total, sn) {
    const srcMerges = []
    for (let r = src.r0; r <= src.r1; r++) {
      for (let c = src.c0; c <= src.c1; c++) {
        const info = merge.getMasterInfo(cellId(r, c), sn)
        if (!info) continue
        if (r + info.rowSpan - 1 > src.r1) continue
        if (c + info.colSpan - 1 > src.c1) continue
        srcMerges.push({
          rOff: r - src.r0,
          cOff: c - src.c0,
          rowSpan: info.rowSpan,
          colSpan: info.colSpan,
        })
      }
    }
    if (!srcMerges.length) return
    const srcRows = src.r1 - src.r0 + 1,
      srcCols = src.c1 - src.c0 + 1
    const goDown = total.r1 > src.r1,
      goUp = total.r0 < src.r0
    const goRight = total.c1 > src.c1,
      goLeft = total.c0 < src.c0

    // Same 2-phase pattern as _fillValues: extend vertically first, then walk
    // every column in the vertically-grown source across the horizontal range.
    // For a diagonal drag, this tiles merges into the full 2D destination
    // instead of just the on-axis strip.
    let workR0 = src.r0,
      workR1 = src.r1
    if (goDown || goUp) {
      const startR = goDown ? src.r1 + 1 : total.r0
      const endR = goDown ? total.r1 : src.r0 - 1
      for (let tileR0 = startR; tileR0 <= endR; tileR0 += srcRows) {
        for (const m of srcMerges) {
          const r0 = tileR0 + m.rOff
          const c0 = src.c0 + m.cOff
          const r1 = r0 + m.rowSpan - 1
          const c1 = c0 + m.colSpan - 1
          if (r1 > endR) continue // drop the partial tile at the far edge
          merge.merge(r0, c0, r1, c1, sn)
        }
      }
      workR0 = Math.min(workR0, total.r0)
      workR1 = Math.max(workR1, total.r1)
    }
    if (goRight || goLeft) {
      // Re-enumerate merges over the vertically-grown source so phase 2 also
      // catches every merge tiled in by phase 1.
      const grownMerges = []
      for (let r = workR0; r <= workR1; r++) {
        for (let c = src.c0; c <= src.c1; c++) {
          const info = merge.getMasterInfo(cellId(r, c), sn)
          if (!info) continue
          if (r + info.rowSpan - 1 > workR1) continue
          if (c + info.colSpan - 1 > src.c1) continue
          grownMerges.push({
            rOff: r - workR0,
            cOff: c - src.c0,
            rowSpan: info.rowSpan,
            colSpan: info.colSpan,
          })
        }
      }
      const startC = goRight ? src.c1 + 1 : total.c0
      const endC = goRight ? total.c1 : src.c0 - 1
      for (let tileC0 = startC; tileC0 <= endC; tileC0 += srcCols) {
        for (const m of grownMerges) {
          const r0 = workR0 + m.rOff
          const c0 = tileC0 + m.cOff
          const r1 = r0 + m.rowSpan - 1
          const c1 = c0 + m.colSpan - 1
          if (c1 > endC) continue
          merge.merge(r0, c0, r1, c1, sn)
        }
      }
    }
  }
  function _fillFormatsOnly(src, total, sn) {
    const srcRows = src.r1 - src.r0 + 1,
      srcCols = src.c1 - src.c0 + 1
    for (let r = total.r0; r <= total.r1; r++) {
      for (let c = total.c0; c <= total.c1; c++) {
        if (r >= src.r0 && r <= src.r1 && c >= src.c0 && c <= src.c1) continue
        const srcR = src.r0 + ((r - src.r0 + srcRows) % srcRows)
        const srcC = src.c0 + ((c - src.c0 + srcCols) % srcCols)
        const fmt = formats.get(cellId(srcR, srcC), sn)
        if (fmt && Object.keys(fmt).length) formats.set(cellId(r, c), fmt, sn)
        else formats.clear(cellId(r, c), sn)
      }
    }
  }
  function _clearFormats(src, total, sn) {
    for (let r = total.r0; r <= total.r1; r++) {
      for (let c = total.c0; c <= total.c1; c++) {
        if (r >= src.r0 && r <= src.r1 && c >= src.c0 && c <= src.c1) continue
        formats.clear(cellId(r, c), sn)
      }
    }
  }
  // The series a fill from `src` would continue (null = plain copy).
  async function _previewSeriesKind(src) {
    const sn = currentSheet.value
    const sel = getGrid()?.getSelection()
    const goingDown = sel ? sel.r1 > src.r1 : false
    const goingRight = sel ? sel.c1 > src.c1 : false
    const sampleAlongCol = goingDown || !goingRight
    const inputs = await _readInputs(src, sn)
    const vals = []
    if (sampleAlongCol) {
      for (let r = src.r0; r <= src.r1; r++) vals.push(inputs[cellId(r, src.c0)])
    } else {
      for (let c = src.c0; c <= src.c1; c++) vals.push(inputs[cellId(src.r0, c)])
    }
    const series = detectSeries(vals.map((v) => (v == null ? '' : String(v))))
    return series ? series.kind : null
  }

  // Cmd/Ctrl held inverts the auto-detected mode — Google Sheets behaviour.
  async function _fillFromHandle(src, total, withModifier) {
    const mode = withModifier ? ((await _previewSeriesKind(src)) ? 'copy' : 'series') : 'auto'
    await _runFill(src, total, mode)
  }

  // Ctrl+D / Ctrl+R: copy the selection's first row down (or first column
  // right) across the rest of it.
  async function _fillFromEdge(down) {
    if (!getGrid()) return
    const sel = getGrid().getSelection()
    const { r0, c0, r1, c1 } = sel
    if (down ? r1 <= r0 : c1 <= c0) return
    const sn = currentSheet.value
    const dest = down ? { r0: r0 + 1, c0, r1, c1 } : { r0, c0: c0 + 1, r1, c1 }
    if (_rectBlocked(dest, sn)) return
    const before = await _readInputs(sel, sn)
    const after = {}
    for (let r = dest.r0; r <= dest.r1; r++) {
      for (let c = dest.c0; c <= dest.c1; c++) {
        const srcVal = before[down ? cellId(r0, c) : cellId(r, c0)] ?? ''
        after[cellId(r, c)] = srcVal.startsWith('=')
          ? adjustFormula(srcVal, down ? r - r0 : 0, down ? 0 : c - c0)
          : srcVal
      }
    }
    _writeInputs(sn, after)
    _pushEditOp(sn, before, after, down ? 'Fill down' : 'Fill right')
  }
  function fillDown() {
    _fillFromEdge(true).catch((e) => console.error('[sheets] fill down failed', e))
  }
  function fillRight() {
    _fillFromEdge(false).catch((e) => console.error('[sheets] fill right failed', e))
  }

  return { fillFromHandle: _fillFromHandle, fillDown, fillRight }
}
