/**
 * OwlCoda Native Skill Tool
 *
 * Executes a registered skill by name. Skills are reusable prompt templates
 * that can be loaded from the skills directory.
 *
 * Supports project, user, and builtin skill locations.
 */

import { readFile, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { NativeToolDef, ToolResult } from './types.js'

export interface SkillInput {
  skill: string
}

interface SkillDef {
  name: string
  description: string
  prompt: string
  location: 'project' | 'user' | 'builtin'
}

async function loadSkillsFromDir(dir: string, location: SkillDef['location']): Promise<SkillDef[]> {
  try {
    await access(dir)
    const files = await readdir(dir)
    const skills: SkillDef[] = []

    for (const file of files) {
      if (!file.endsWith('.md') && !file.endsWith('.txt')) continue
      try {
        const content = await readFile(join(dir, file), 'utf-8')
        const name = file.replace(/\.(md|txt)$/, '')
        // Extract description from first line if it starts with #
        const firstLine = content.split('\n')[0] ?? ''
        const description = firstLine.startsWith('#')
          ? firstLine.replace(/^#+\s*/, '')
          : name

        skills.push({ name, description, prompt: content, location })
      } catch {
        // Skip unreadable files
      }
    }
    return skills
  } catch {
    return []
  }
}

export function createSkillTool(cwd?: string): NativeToolDef<SkillInput> {
  return {
    name: 'Skill',
    description:
      'Execute a registered skill by name. Skills are reusable prompt templates ' +
      'loaded from project or user skill directories.',

    async execute(input: SkillInput): Promise<ToolResult> {
      const { skill } = input

      if (!skill || typeof skill !== 'string') {
        return { output: 'Error: skill name is required.', isError: true }
      }

      // Load skills from multiple locations
      const projectDir = cwd ? join(cwd, '.owlcoda', 'skills') : ''
      const userDir = join(homedir(), '.owlcoda', 'skills')

      const allSkills: SkillDef[] = [
        ...(projectDir ? await loadSkillsFromDir(projectDir, 'project') : []),
        ...await loadSkillsFromDir(userDir, 'user'),
      ]

      // Find matching skill
      const found = allSkills.find(s => s.name.toLowerCase() === skill.toLowerCase())

      if (!found) {
        const available = allSkills.map(s => s.name).join(', ') || '(none)'
        return {
          output: `Skill "${skill}" not found. Available: ${available}`,
          isError: true,
          metadata: { available: allSkills.map(s => s.name) },
        }
      }

      return {
        output: found.prompt,
        isError: false,
        metadata: {
          skill: found.name,
          location: found.location,
          description: found.description,
        },
      }
    },
  }
}
