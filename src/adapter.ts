import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { CodexBridgeManager, type BridgeConfig } from './bridge.js'

export const CODEX_PROVIDER = 'codex-cli'

export class CodexAdapter extends LlmAdapter {
  readonly #manager: CodexBridgeManager

  constructor(
    subprocess: SubprocessRuntime,
    attachments: AttachmentStore | undefined,
    readonly config: BridgeConfig,
  ) {
    super()
    this.#manager = new CodexBridgeManager(subprocess, attachments, config)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: 'Codex CLI (ChatGPT login)',
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.#manager.listModels()
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.displayName,
      description: model.description,
      inputModalities: model.inputModalities.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'),
    }))
  }

  override async resolveModel(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const model = (await this.#manager.listModels(signal)).find(candidate => candidate.id === modelId)
    if (model === undefined) {
      return {
        provider,
        id: modelId,
        name: modelId,
        context: { contextWindow: this.config.contextWindow },
      }
    }
    return {
      provider,
      id: model.id,
      name: model.displayName,
      description: model.description,
      inputModalities: model.inputModalities.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'),
      context: { contextWindow: this.config.contextWindow },
      reasoning: {
        efforts: model.supportedReasoningEfforts.map(effort => ({
          id: ReasoningEffortId(effort.reasoningEffort),
          name: effort.reasoningEffort,
          description: effort.description,
        })),
        defaultEffort: ReasoningEffortId(model.defaultReasoningEffort),
      },
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.#manager.stream(options)
  }

  dispose(): Promise<void> {
    return this.#manager.dispose()
  }
}
