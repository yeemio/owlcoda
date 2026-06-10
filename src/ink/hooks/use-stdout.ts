import { useContext } from 'react'
import { TerminalSizeContext } from '../components/TerminalSizeContext.js'

// Mirrors upstream ink's useStdout shape so callers migrating off
// `from 'ink'` to the vendored fork don't have to change usage sites.
// Returns { stdout, write } where stdout exposes resize-reactive
// columns/rows from TerminalSizeContext (App.tsx provides terminalColumns
// and terminalRows on every SIGWINCH), and write goes straight to
// process.stdout.
type StdoutLike = {
  columns: number
  rows: number
  write: (chunk: string) => void
}

type UseStdoutResult = {
  stdout: StdoutLike
  write: (chunk: string) => void
}

const writeToProcessStdout = (chunk: string): void => {
  process.stdout.write(chunk)
}

const useStdout = (): UseStdoutResult => {
  const size = useContext(TerminalSizeContext)
  const columns = size?.columns ?? process.stdout.columns ?? 80
  const rows = size?.rows ?? process.stdout.rows ?? 24
  return {
    stdout: { columns, rows, write: writeToProcessStdout },
    write: writeToProcessStdout,
  }
}

export default useStdout
