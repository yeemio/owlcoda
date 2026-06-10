import { describe, expect, it } from 'vitest'
import { classifyPowerShellCommand } from '../../src/native/powershell-risk.js'

describe('classifyPowerShellCommand', () => {
  it.each([
    'Set-Content -Path x.txt -Value a',
    'Remove-Item ./x.txt',
    'New-Item -ItemType File f.txt',
    "'a' > out.txt",
    'Get-Content x | Set-Content y',
    'Get-Process | Export-Csv procs.csv',
    'Select-Object x | Tee-Object -FilePath out.txt',
    'Invoke-WebRequest http://x -OutFile f.zip',
  ])('flags mutating command: %s', (cmd) => {
    expect(classifyPowerShellCommand(cmd).mutatesFilesystem).toBe(true)
  })

  it.each(['Get-ChildItem -Path .', 'Select-String foo *.ts', 'Write-Output hi'])(
    'allows read-only command: %s',
    (cmd) => {
      expect(classifyPowerShellCommand(cmd).mutatesFilesystem).toBe(false)
    },
  )

  it.each(['', '   ', 'Frobnicate-Widget', '42'])(
    'fails closed (treats unknown/empty as mutating): %s',
    (cmd) => {
      expect(classifyPowerShellCommand(cmd).mutatesFilesystem).toBe(true)
    },
  )
})
