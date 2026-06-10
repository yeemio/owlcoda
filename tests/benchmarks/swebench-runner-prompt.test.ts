import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractInspectedPaths,
  prepareRunOutputFiles,
  readCompletedIds,
  recoveryTaskNoProgressLimit,
} from '../../scripts/swebench-lite-run.ts'

const runnerSource = () => readFileSync(join(process.cwd(), 'scripts', 'swebench-lite-run.ts'), 'utf8')

describe('SWE-bench runner prompt guardrails', () => {
  it('keeps unattended runs on structured tools before shell checks', () => {
    const source = runnerSource()

    expect(source).toContain('Use structured Read/Grep/Edit/Write tools for repository inspection and code changes.')
    expect(source).toContain('Do not use bash for file inspection, grep, echo, file creation, cleanup, patching, local builds, or dependency setup.')
    expect(source).toContain('If you need to inspect files, use Read or Grep tools. If you need to modify files, use Edit or Write tools.')
  })

  it('pins first-edit and finish-after-patch constraints', () => {
    const source = runnerSource()

    expect(source).toContain('Make a plausible minimal edit by the third tool call whenever the target file is reasonably identifiable.')
    expect(source).toContain('After producing a non-empty patch, finish immediately.')
    expect(source).toContain('Do not run verification commands in this unattended generation pass')
    expect(source).toContain('tests were not run by this unattended runner')
    expect(source).toContain('Do not finish until you have either produced a non-empty repository diff or reported a concrete blocker.')
  })

  it('continues to discourage shell patterns that caused sanity-denial drift', () => {
    const source = runnerSource()

    for (const forbiddenPattern of [
      'shell redirection',
      'rm',
      'grep/rg through bash',
      'echo through bash',
      'tee',
      'sed -i',
      'perl -pi',
      'python -c',
      'git -C through bash',
      'pip install',
      'setup.py build_ext',
    ]) {
      expect(source).toContain(forbiddenPattern)
    }
  })

  it('keeps zero-diff task_no_progress recovery bounded to one edit-first retry', () => {
    const source = runnerSource()

    expect(source).toContain('task_no_progress recovery queued after 0B patch')
    expect(source).toContain('This is the one recovery attempt for the same checkout.')
    expect(source).toContain('Hard first action: your first tool call in this recovery attempt must be Edit or Write.')
    expect(source).toContain('Do not call Read, Grep, Bash, or any other inspection tool before the first edit.')
    expect(source).toContain('Previously inspected files:')
  })

  it('uses a shorter no-progress guard for recovery attempts', () => {
    expect(recoveryTaskNoProgressLimit('40')).toBe('12')
    expect(recoveryTaskNoProgressLimit('8')).toBe('8')
    expect(recoveryTaskNoProgressLimit('unlimited')).toBe('12')
  })

  it('extracts inspected paths when macOS reports /private/tmp for a /tmp workspace', () => {
    const workspace = '/tmp/owlcoda-swebench-run/instances/django__django-11964'
    const result = {
      tool_calls: [
        {
          input: {
            path: '/private/tmp/owlcoda-swebench-run/instances/django__django-11964/django/db/models/fields/__init__.py',
          },
        },
        {
          input: {
            path: '/private/tmp/owlcoda-swebench-run/instances/django__django-11964/django/db/models/base.py',
          },
        },
      ],
    }

    expect(extractInspectedPaths(result, workspace)).toEqual([
      'django/db/models/fields/__init__.py',
      'django/db/models/base.py',
    ])
  })

  it('reads completed ids for resume and preserves existing output files', () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-swebench-resume-'))
    try {
      const paths = {
        predictions: join(root, 'predictions.jsonl'),
        records: join(root, 'records.jsonl'),
        infraFailures: join(root, 'infra-failures.jsonl'),
        providerFailures: join(root, 'provider-failures.jsonl'),
      }
      writeFileSync(paths.predictions, 'prediction-kept\n')
      writeFileSync(paths.records, [
        JSON.stringify({ instance_id: 'django__django-1' }),
        JSON.stringify({ instance_id: 'astropy__astropy-1' }),
        '',
      ].join('\n'))
      writeFileSync(paths.infraFailures, 'infra-kept\n')
      writeFileSync(paths.providerFailures, 'provider-kept\n')

      expect(Array.from(readCompletedIds(paths.records))).toEqual([
        'django__django-1',
        'astropy__astropy-1',
      ])

      prepareRunOutputFiles(paths, true)

      expect(readFileSync(paths.predictions, 'utf8')).toBe('prediction-kept\n')
      expect(readFileSync(paths.records, 'utf8')).toContain('django__django-1')
      expect(readFileSync(paths.infraFailures, 'utf8')).toBe('infra-kept\n')
      expect(readFileSync(paths.providerFailures, 'utf8')).toBe('provider-kept\n')

      prepareRunOutputFiles(paths, false)

      expect(readFileSync(paths.predictions, 'utf8')).toBe('')
      expect(readFileSync(paths.records, 'utf8')).toBe('')
      expect(readFileSync(paths.infraFailures, 'utf8')).toBe('')
      expect(readFileSync(paths.providerFailures, 'utf8')).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
