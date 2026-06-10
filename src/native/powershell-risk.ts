/**
 * Minimal PowerShell mutation classifier — mirrors bash-risk.ts's
 * `mutatesFilesystem` signal so plan mode has no PowerShell bypass.
 * Conservative / fail-closed: anything not clearly read-only is "mutating".
 * v1 known over-blocks (acceptable in read-only plan mode): some non-FS verb
 * cmdlets like Set-Location / Clear-Host classify as mutating.
 */
export interface PowerShellRiskClassification {
  mutatesFilesystem: boolean
  reasons: string[]
  command: string
}

const PS_MUTATING_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:Set|Add|Clear|Remove|New|Move|Rename|Copy)-(?:Content|Item|ItemProperty)\b/i, 'mutating file/item cmdlet'],
  [/\b(?:Out-File|Add-Content|Set-Content|Clear-Content|New-Item|Remove-Item|Move-Item|Rename-Item|Copy-Item)\b/i, 'mutating cmdlet'],
  [/\b(?:rm|del|erase|rd|rmdir|md|mkdir|mv|move|cp|copy|ren|ri|ni|mi)\b/i, 'mutating alias'],
  [/(?:^|\s)>>?[^&>]/, 'file redirection'],
  [/\b(?:Tee-Object|Export-Csv|Export-Clixml|Set-Acl)\b/i, 'file-writing cmdlet'],
  [/(?:^|\s)-OutFile\b/i, 'download-to-file parameter'],
]

const PS_READONLY_LEADING =
  /^\s*(?:Get|Select|Where|Measure|Sort|Format|Compare|Test-Path|Resolve-Path|ConvertTo|ConvertFrom|Read-Host|Write-Host|Write-Output|Out-String|Out-Host|Echo)\b/i

export function classifyPowerShellCommand(command: unknown): PowerShellRiskClassification {
  if (typeof command !== 'string' || !command.trim()) {
    return { mutatesFilesystem: true, reasons: ['empty/non-string (fail-closed)'], command: '' }
  }
  const trimmed = command.trim()
  const reasons: string[] = []
  for (const [re, reason] of PS_MUTATING_PATTERNS) {
    if (re.test(trimmed)) reasons.push(reason)
  }
  if (reasons.length > 0) return { mutatesFilesystem: true, reasons, command: trimmed }
  if (PS_READONLY_LEADING.test(trimmed)) {
    return { mutatesFilesystem: false, reasons: ['read-only leading cmdlet'], command: trimmed }
  }
  return { mutatesFilesystem: true, reasons: ['unrecognized command (fail-closed)'], command: trimmed }
}
