import { randomUUID } from 'node:crypto'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  CallId,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { AppServerClient, AppServerEvent } from './rpc-client.js'
import {
  isRecord,
  type CodexModel,
  type DynamicToolCallParams,
  type ReplayState,
  type TokenBreakdown,
  type TurnCompletedParams,
} from './protocol.js'
import { listAllModels, startClient, type ProcessConfig } from './process.js'
import {
  dynamicTools,
  findToolResults,
  firstTurnInput,
  nextTurnInput,
  toolOutput,
  toolSignature,
} from './translate.js'

const CLIENT_INSTRUCTIONS = [
  'You are the primary model inside DeepSeek Harness (DSH).',
  'Use only dynamic tools supplied by the DSH client for external actions.',
  'Do not use Codex-native shell, file, patch, MCP, browser, or delegation tools.',
  'When a DSH tool is appropriate, call it and wait for its result.',
  'Do not use a read tool to test whether an optional or candidate path exists. First use glob or a non-error bash existence test when available, then read only confirmed matches.',
  'Treat a successful DSH tool result as authoritative and continue the current task; do not repeat the completed action or question unless the result is missing or ambiguous.',
].join('\n')

const DSH_OWNED_TOOL_CONFIG = {
  features: {
    apps: false,
    browser_use: false,
    computer_use: false,
    goals: false,
    hooks: false,
    image_generation: false,
    in_app_browser: false,
    multi_agent: false,
    plugins: false,
    shell_tool: false,
    unified_exec: false,
    workspace_dependencies: false,
  },
  mcp_servers: {},
  web_search: 'disabled',
} as const

interface PendingTool {
  requestId: number | string
  params: DynamicToolCallParams
}

interface SessionState {
  bridgeId: string
  client: AppServerClient
  threadId: string
  turnId?: string
  model: string
  tools: string
  pending: Map<string, PendingTool>
  busy: boolean
  turnCount: number
  lastUsedAt: number
}

interface ThreadStartResponse {
  thread: { id: string }
  model: string
}

interface TurnStartResponse {
  turn: { id: string }
}

export interface BridgeConfig extends ProcessConfig {
  allowCodexNativeTools: boolean
  contextWindow: number
  modelCacheMs: number
  sessionIdleMs: number
}

function sessionKey(options: GenerateOptions): string {
  return options.sessionId ?? `oneshot:${randomUUID()}`
}

function paramsOf<T>(event: AppServerEvent): T | undefined {
  if (event.type !== 'notification' && event.type !== 'request') return undefined
  return event.value.params as T | undefined
}

function tokenUsage(value: TokenBreakdown): TokenUsage {
  const uncached = Math.max(0, value.inputTokens - value.cachedInputTokens - value.cacheWriteInputTokens)
  return {
    inputTokens: uncached,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cachedInputTokens,
    cacheWriteTokens: value.cacheWriteInputTokens,
    reasoningTokens: value.reasoningOutputTokens,
  }
}

function replay(state: SessionState): ReplayState {
  return {
    protocol: 'dsh-codex/1',
    bridgeId: state.bridgeId,
    threadId: state.threadId,
    turnId: state.turnId ?? '',
    ...(state.pending.size === 0 ? {} : { pendingCallIds: [...state.pending.keys()] }),
  }
}

export class CodexBridgeManager {
  readonly #sessions = new Map<string, SessionState>()
  #modelCache: { expiresAt: number; models: CodexModel[] } | undefined

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly attachments: AttachmentStore | undefined,
    private readonly config: BridgeConfig,
  ) {}

  async listModels(signal?: AbortSignal): Promise<CodexModel[]> {
    if (this.#modelCache !== undefined && this.#modelCache.expiresAt > Date.now()) {
      return structuredClone(this.#modelCache.models)
    }
    const { client } = await startClient(this.subprocess, this.config, signal)
    try {
      const models = await listAllModels(client, signal)
      this.#modelCache = { expiresAt: Date.now() + this.config.modelCacheMs, models }
      return structuredClone(models)
    } finally {
      client.terminate()
      await client.waitForExit().catch(() => false)
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.#evictIdle()
    const key = sessionKey(options)
    let state = this.#sessions.get(key)
    if (state !== undefined && state.tools !== toolSignature(options.tools)) {
      await this.#disposeState(key, state)
      state = undefined
    }
    if (state === undefined) {
      state = await this.#startSession(options)
      if (options.sessionId !== undefined) this.#sessions.set(key, state)
    }
    if (state.busy) throw new Error(`Concurrent Codex calls are not supported for DSH session ${key}`)
    state.busy = true
    state.lastUsedAt = Date.now()
    try {
      if (state.pending.size > 0) {
        await this.#resumeTools(state, options)
      } else {
        const input = state.turnCount === 0
          ? await firstTurnInput(options, this.attachments)
          : await nextTurnInput(options, this.attachments)
        const started = await state.client.request<TurnStartResponse>('turn/start', {
          threadId: state.threadId,
          input,
          model: options.model,
          ...(options.reasoningEffort === undefined ? {} : { effort: options.reasoningEffort }),
          environments: [],
          approvalPolicy: 'never',
        }, options.signal)
        state.turnId = started.turn.id
        state.turnCount += 1
      }
      yield* this.#consumeTurn(state, options)
    } finally {
      state.busy = false
      state.lastUsedAt = Date.now()
      if (options.sessionId === undefined) await this.#disposeState(key, state)
    }
  }

  async dispose(): Promise<void> {
    const entries = [...this.#sessions.entries()]
    this.#sessions.clear()
    await Promise.all(entries.map(async ([, state]) => {
      state.client.terminate()
      await state.client.waitForExit().catch(() => false)
    }))
  }

  async #startSession(options: GenerateOptions): Promise<SessionState> {
    const { client } = await startClient(this.subprocess, this.config, options.signal)
    try {
      const started = await client.request<ThreadStartResponse>('thread/start', {
        model: options.model,
        cwd: this.config.cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: options.system ?? null,
        developerInstructions: CLIENT_INSTRUCTIONS,
        ephemeral: true,
        historyMode: 'legacy',
        environments: [],
        ...this.config.allowCodexNativeTools ? {} : { config: DSH_OWNED_TOOL_CONFIG },
        dynamicTools: dynamicTools(options.tools),
      }, options.signal)
      return {
        bridgeId: randomUUID(),
        client,
        threadId: started.thread.id,
        model: started.model,
        tools: toolSignature(options.tools),
        pending: new Map(),
        busy: false,
        turnCount: 0,
        lastUsedAt: Date.now(),
      }
    } catch (error) {
      client.terminate()
      throw error
    }
  }

  async #resumeTools(state: SessionState, options: GenerateOptions): Promise<void> {
    const results = findToolResults(options.messages, new Set(state.pending.keys()))
    if (results.length !== state.pending.size) {
      const missing = [...state.pending.keys()].filter(id => !results.some(result => result.toolCallId === id))
      throw new Error(`Codex is waiting for DSH tool result(s): ${missing.join(', ')}`)
    }
    for (const result of results) {
      const pending = state.pending.get(result.toolCallId)
      if (pending === undefined) continue
      state.client.respond(pending.requestId, {
        contentItems: await toolOutput(result, this.attachments, options.signal),
        success: result.isError !== true,
      })
      state.pending.delete(result.toolCallId)
    }
  }

  async *#consumeTurn(state: SessionState, options: GenerateOptions): AsyncIterable<StreamChunk> {
    let nextIndex = 0
    let textIndex: number | undefined
    let text = ''
    let reasoningIndex: number | undefined
    let reasoning = ''
    let latestUsage: TokenUsage | undefined

    const closeBlocks = (): StreamChunk[] => {
      const chunks: StreamChunk[] = []
      if (reasoningIndex !== undefined) {
        chunks.push({ type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } })
        reasoningIndex = undefined
      }
      if (textIndex !== undefined) {
        chunks.push({ type: 'block-end', index: textIndex, block: { type: 'text', text } })
        textIndex = undefined
      }
      return chunks
    }

    for (;;) {
      let event: AppServerEvent
      try {
        event = await state.client.nextEvent(options.signal)
      } catch (error) {
        if (options.signal?.aborted === true) {
          if (state.turnId !== undefined) {
            state.client.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId }).catch(() => undefined)
          }
          for (const chunk of closeBlocks()) yield chunk
          yield {
            type: 'finish',
            reason: { kind: 'aborted', failure: { message: 'Codex turn aborted', code: 'ABORTED' } },
          }
          return
        }
        throw error
      }

      if (event.type === 'closed') {
        throw new Error(`Codex App Server exited during a turn (exit=${String(event.exitCode)}, signal=${String(event.signal)})`)
      }
      if (event.type === 'protocol-error') throw event.error
      if (event.type === 'request') {
        if (event.value.method !== 'item/tool/call') {
          state.client.respondError(event.value.id, -32601, `DSH does not implement Codex server request ${event.value.method}`)
          continue
        }
        const params = paramsOf<DynamicToolCallParams>(event)
        if (params === undefined || typeof params.callId !== 'string' || typeof params.tool !== 'string') {
          state.client.respondError(event.value.id, -32602, 'Invalid dynamic tool call')
          continue
        }
        state.pending.set(params.callId, { requestId: event.value.id, params })
        for (const chunk of closeBlocks()) yield chunk
        const index = nextIndex++
        const argumentsJson = JSON.stringify(params.arguments ?? {})
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index,
          id: CallId(params.callId),
          name: params.tool,
          argumentsDelta: argumentsJson,
        }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: CallId(params.callId), name: params.tool, arguments: argumentsJson },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState: replay(state) }
        return
      }

      const method = event.value.method
      if (method === 'item/agentMessage/delta') {
        const params = paramsOf<{ delta?: unknown }>(event)
        if (typeof params?.delta !== 'string' || params.delta.length === 0) continue
        if (textIndex === undefined) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        text += params.delta
        yield { type: 'text-delta', index: textIndex, text: params.delta }
        continue
      }
      if (method === 'item/reasoning/summaryTextDelta') {
        const params = paramsOf<{ delta?: unknown }>(event)
        if (typeof params?.delta !== 'string' || params.delta.length === 0) continue
        if (reasoningIndex === undefined) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        reasoning += params.delta
        yield { type: 'reasoning-delta', index: reasoningIndex, text: params.delta }
        continue
      }
      if (method === 'thread/tokenUsage/updated') {
        const params = paramsOf<{ tokenUsage?: { last?: TokenBreakdown } }>(event)
        if (params?.tokenUsage?.last !== undefined) latestUsage = tokenUsage(params.tokenUsage.last)
        continue
      }
      if (method === 'error') {
        const params = paramsOf<{ error?: { message?: unknown }; willRetry?: unknown }>(event)
        if (params?.willRetry !== true) {
          throw new Error(typeof params?.error?.message === 'string' ? params.error.message : 'Codex turn failed')
        }
        continue
      }
      if (method !== 'turn/completed') continue
      const params = paramsOf<TurnCompletedParams>(event)
      if (params === undefined || params.turn.id !== state.turnId) continue
      for (const chunk of closeBlocks()) yield chunk
      if (latestUsage !== undefined) yield { type: 'usage', usage: latestUsage }
      if (params.turn.status === 'failed') {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: params.turn.error?.message ?? 'Codex turn failed', code: 'CODEX_TURN_FAILED' },
          },
        }
      } else if (params.turn.status === 'interrupted') {
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: 'Codex turn interrupted', code: 'ABORTED' } },
        }
      } else {
        yield { type: 'finish', reason: { kind: 'stop' }, replayState: replay(state) }
      }
      return
    }
  }

  #evictIdle(): void {
    const cutoff = Date.now() - this.config.sessionIdleMs
    for (const [key, state] of this.#sessions) {
      if (!state.busy && state.lastUsedAt < cutoff) void this.#disposeState(key, state)
    }
  }

  async #disposeState(key: string, state: SessionState): Promise<void> {
    if (this.#sessions.get(key) === state) this.#sessions.delete(key)
    state.client.terminate()
    await state.client.waitForExit().catch(() => false)
  }
}
