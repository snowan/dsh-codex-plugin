import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CODEX_PROVIDER, CodexAdapter } from './adapter.js'

export { CODEX_PROVIDER, CodexAdapter } from './adapter.js'
export { CodexBridgeManager, CodexSessionLostError } from './bridge.js'
export { AppServerClient, RpcResponseError } from './rpc-client.js'
export type { ReplayState } from './protocol.js'

export const name = 'dsh-codex-plugin'
export const inject = ['llm', 'subprocess']

export interface Config {
  /** Executable visible inside the DSH subprocess runtime. */
  codexCommand?: string
  /** Working directory assigned to Codex threads. */
  cwd?: string
  /** Explicit environment additions for the Codex process. */
  env?: Record<string, string>
  /** Allow Codex-native tools in addition to DSH dynamic tools. */
  allowCodexNativeTools?: boolean
  /** Grace period before DSH escalates process termination. */
  disposeGraceMs?: number
  /** Context capacity advertised to the DSH compaction policy. */
  contextWindow?: number
  /** Duration to cache Codex model discovery. */
  modelCacheMs?: number
  /** Inactive session duration before its App Server is terminated. */
  sessionIdleMs?: number
}

export const Config: z<Config> = z.object({
  codexCommand: z.string().default('codex'),
  cwd: z.string().default(process.cwd()),
  env: z.dict(z.string()).default({}),
  allowCodexNativeTools: z.boolean().default(false),
  disposeGraceMs: z.number().min(1).max(60_000).default(3_000),
  contextWindow: z.number().step(1).min(1).default(200_000),
  modelCacheMs: z.number().min(1).max(86_400_000).default(300_000),
  sessionIdleMs: z.number().min(1_000).max(86_400_000).default(900_000),
})

function resolved(config: Config): Required<Config> {
  const value: Required<Config> = {
    codexCommand: config.codexCommand ?? 'codex',
    cwd: config.cwd ?? process.cwd(),
    env: config.env ?? {},
    allowCodexNativeTools: config.allowCodexNativeTools ?? false,
    disposeGraceMs: config.disposeGraceMs ?? 3_000,
    contextWindow: config.contextWindow ?? 200_000,
    modelCacheMs: config.modelCacheMs ?? 300_000,
    sessionIdleMs: config.sessionIdleMs ?? 900_000,
  }
  if (value.codexCommand.length === 0) throw new Error('dsh-codex-plugin: codexCommand must be non-empty')
  if (value.cwd.length === 0) throw new Error('dsh-codex-plugin: cwd must be non-empty')
  return value
}

export function apply(ctx: Context, config: Config): void {
  const attachments = ctx.get('attachments') as AttachmentStore | undefined
  const adapter = new CodexAdapter(ctx.subprocess, attachments, resolved(config))
  ctx.llm.registerAdapter([CODEX_PROVIDER], adapter)
  ctx.effect(() => async () => adapter.dispose(), 'dsh-codex-plugin sessions')
}
