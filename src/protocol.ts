export type JsonObject = Record<string, unknown>
export type RequestId = number | string

export interface RpcRequest {
  id: RequestId
  method: string
  params?: unknown
}

export interface RpcNotification {
  method: string
  params?: unknown
}

export interface RpcSuccess {
  id: RequestId
  result: unknown
}

export interface RpcFailure {
  id: RequestId
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure

export interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  inputModalities: string[]
  defaultReasoningEffort: string
  supportedReasoningEfforts: Array<{
    reasoningEffort: string
    description: string
  }>
}

export interface ModelListResponse {
  data: CodexModel[]
  nextCursor: string | null
}

export interface DynamicToolCallParams {
  threadId: string
  turnId: string
  callId: string
  namespace: string | null
  tool: string
  arguments: unknown
}

export interface TokenBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface TurnCompletedParams {
  threadId: string
  turn: {
    id: string
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
    error: { message: string } | null
  }
}

export interface ReplayState {
  protocol: 'dsh-codex/1'
  bridgeId: string
  threadId: string
  turnId: string
  pendingCallIds?: string[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasMethod(value: unknown): value is RpcRequest | RpcNotification {
  return isRecord(value) && typeof value.method === 'string'
}

export function hasId(value: unknown): value is RpcRequest | RpcSuccess | RpcFailure {
  return isRecord(value) && (typeof value.id === 'number' || typeof value.id === 'string')
}
