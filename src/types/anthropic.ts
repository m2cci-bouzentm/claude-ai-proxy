export * from "../schemas/anthropic.schema"
export * from "../schemas/provider.schema"

export interface ClaudeMetadata {
  user_id: string
}

export interface SystemPromptBlock {
  type: string
  text?: string
}
