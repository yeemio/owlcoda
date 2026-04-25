export type Message = { type: string; content?: any[] }
export type UserMessage = Message & { type: 'user' }
export type AssistantMessage = Message & { type: 'assistant' }
export type MessageOrigin = 'user' | 'system' | 'tool'
