import type { AnthropicToolDef, AnthropicToolChoice, OpenAIToolDef } from '../types.js'

export function translateTools(tools: AnthropicToolDef[]): OpenAIToolDef[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      ...(t.description !== undefined && { description: t.description }),
      parameters: t.input_schema,
    },
  }))
}

export function translateToolChoice(
  choice: AnthropicToolChoice | undefined,
): string | { type: string; function: { name: string } } | undefined {
  if (choice === undefined) return undefined
  switch (choice.type) {
    case 'auto': return 'auto'
    case 'any': return 'required'
    case 'none': return 'none'
    case 'tool': return { type: 'function', function: { name: choice.name } }
  }
}
