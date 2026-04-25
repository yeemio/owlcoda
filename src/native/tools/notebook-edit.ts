/**
 * OwlCoda Native NotebookEdit Tool
 *
 * Edit Jupyter notebook (.ipynb) cells — replace, insert, or delete.
 * Notebooks are standard nbformat v4+ JSON.
 *
 * Upstream parity notes:
 * - Upstream NotebookEditTool validates read-before-edit via readFileState
 * - Supports replace/insert/delete modes with cell_id or index
 * - Resets execution_count & outputs on code cell edits
 * - Our version: same operations, simpler permission model
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import type { NotebookEditInput, NativeToolDef, ToolResult } from './types.js'

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw'
  id?: string
  source: string | string[]
  metadata: Record<string, unknown>
  execution_count?: number | null
  outputs?: unknown[]
}

interface NotebookContent {
  nbformat: number
  nbformat_minor: number
  metadata: {
    language_info?: { name?: string }
    [k: string]: unknown
  }
  cells: NotebookCell[]
}

/** Parse cell-N style cell IDs → numeric index. */
function parseCellIndex(cellId: string): number | undefined {
  const m = /^cell-(\d+)$/i.exec(cellId)
  return m ? parseInt(m[1]!, 10) : undefined
}

export function createNotebookEditTool(): NativeToolDef<NotebookEditInput> {
  return {
    name: 'NotebookEdit',
    description:
      'Edit Jupyter notebook cells (.ipynb). Supports replace, insert, and delete modes. ' +
      'Specify cell_id to target a cell by ID or index (e.g. "cell-3").',

    async execute(input: NotebookEditInput): Promise<ToolResult> {
      const { notebook_path, new_source, cell_id, cell_type, edit_mode = 'replace' } = input

      // Resolve path
      const fullPath = isAbsolute(notebook_path)
        ? notebook_path
        : resolve(process.cwd(), notebook_path)

      // Validate extension
      if (extname(fullPath) !== '.ipynb') {
        return {
          output: 'File must be a Jupyter notebook (.ipynb). Use the edit tool for other file types.',
          isError: true,
        }
      }

      // Validate edit_mode
      if (!['replace', 'insert', 'delete'].includes(edit_mode)) {
        return {
          output: `Invalid edit_mode "${edit_mode}". Must be replace, insert, or delete.`,
          isError: true,
        }
      }

      // Insert requires cell_type
      if (edit_mode === 'insert' && !cell_type) {
        return {
          output: 'cell_type is required when using edit_mode=insert.',
          isError: true,
        }
      }

      // Read notebook
      if (!existsSync(fullPath)) {
        return {
          output: `Notebook file does not exist: ${fullPath}`,
          isError: true,
        }
      }

      let raw: string
      try {
        raw = readFileSync(fullPath, 'utf-8')
      } catch (err) {
        return {
          output: `Failed to read notebook: ${(err as Error).message}`,
          isError: true,
        }
      }

      let notebook: NotebookContent
      try {
        notebook = JSON.parse(raw) as NotebookContent
      } catch {
        return { output: 'Notebook is not valid JSON.', isError: true }
      }

      if (!Array.isArray(notebook.cells)) {
        return { output: 'Notebook has no cells array.', isError: true }
      }

      // Locate cell index
      let cellIndex: number
      if (!cell_id) {
        if (edit_mode !== 'insert') {
          return {
            output: 'cell_id must be specified for replace/delete operations.',
            isError: true,
          }
        }
        cellIndex = 0 // insert at beginning
      } else {
        // Try by ID first
        cellIndex = notebook.cells.findIndex(c => c.id === cell_id)
        if (cellIndex === -1) {
          // Try cell-N index
          const parsed = parseCellIndex(cell_id)
          if (parsed !== undefined && parsed >= 0 && parsed < notebook.cells.length) {
            cellIndex = parsed
          } else if (parsed !== undefined) {
            return {
              output: `Cell index ${parsed} out of range (notebook has ${notebook.cells.length} cells).`,
              isError: true,
            }
          } else {
            return {
              output: `Cell with ID "${cell_id}" not found in notebook.`,
              isError: true,
            }
          }
        }
        if (edit_mode === 'insert') {
          cellIndex += 1 // insert after target
        }
      }

      const language = notebook.metadata.language_info?.name ?? 'python'

      // Generate cell ID for nbformat ≥ 4.5
      const needsId =
        notebook.nbformat > 4 ||
        (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
      const newCellId = needsId
        ? Math.random().toString(36).substring(2, 15)
        : undefined

      // Execute operation
      if (edit_mode === 'delete') {
        notebook.cells.splice(cellIndex, 1)
      } else if (edit_mode === 'insert') {
        const newCell: NotebookCell =
          cell_type === 'markdown'
            ? { cell_type: 'markdown', id: newCellId, source: new_source, metadata: {} }
            : {
                cell_type: 'code',
                id: newCellId,
                source: new_source,
                metadata: {},
                execution_count: null,
                outputs: [],
              }
        notebook.cells.splice(cellIndex, 0, newCell)
      } else {
        // replace
        const target = notebook.cells[cellIndex]!
        target.source = new_source
        if (target.cell_type === 'code') {
          target.execution_count = null
          target.outputs = []
        }
        if (cell_type && cell_type !== target.cell_type) {
          target.cell_type = cell_type
        }
      }

      // Write back
      const updatedContent = JSON.stringify(notebook, null, 1)
      try {
        writeFileSync(fullPath, updatedContent, 'utf-8')
      } catch (err) {
        return {
          output: `Failed to write notebook: ${(err as Error).message}`,
          isError: true,
        }
      }

      const modeLabel = edit_mode === 'delete' ? 'Deleted' : edit_mode === 'insert' ? 'Inserted' : 'Updated'
      const cellLabel = cell_id ?? (newCellId ?? 'cell-0')

      return {
        output: `${modeLabel} cell ${cellLabel} in ${fullPath}`,
        isError: false,
        metadata: {
          notebook_path: fullPath,
          cell_id: cellLabel,
          cell_type: cell_type ?? 'code',
          language,
          edit_mode,
        },
      }
    },
  }
}
