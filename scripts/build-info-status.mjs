function isRunKitTruthPath(path) {
  return path === '.owlcoda/runkit' || path.startsWith('.owlcoda/runkit/')
}

export function hasProductSourceChanges(status) {
  const entries = status.split('\0')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    const code = entry.slice(0, 2)
    const paths = [entry.slice(3)]
    if (code.includes('R') || code.includes('C')) {
      const otherPath = entries[index + 1]
      if (otherPath) {
        paths.push(otherPath)
        index += 1
      }
    }
    if (paths.some(path => !isRunKitTruthPath(path))) return true
  }
  return false
}
