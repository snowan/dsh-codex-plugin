import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { AppServerClient } from './rpc-client.js'
import type { ModelListResponse } from './protocol.js'

export interface ProcessConfig {
  codexCommand: string
  cwd: string
  env: Record<string, string>
  disposeGraceMs: number
}

export interface InitializedClient {
  client: AppServerClient
  executable: string
}

export async function startClient(
  subprocess: SubprocessRuntime,
  config: ProcessConfig,
  signal?: AbortSignal,
): Promise<InitializedClient> {
  const executable = await subprocess.resolveExecutable(config.codexCommand, config.env, signal)
  const handle: SubprocessHandle = subprocess.spawn({
    argv: [executable, 'app-server', '--stdio'],
    cwd: config.cwd,
    env: config.env,
    graceMs: config.disposeGraceMs,
    stdio: {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: { maxBytes: 64 * 1024 },
    },
  })
  const client = new AppServerClient(handle)
  try {
    await client.request('initialize', {
      clientInfo: {
        name: 'dsh-codex-plugin',
        title: 'DeepSeek Harness Codex Adapter',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    }, signal)
    client.notify('initialized')
    return { client, executable }
  } catch (error) {
    client.terminate()
    throw error
  }
}

export async function listAllModels(client: AppServerClient, signal?: AbortSignal): Promise<ModelListResponse['data']> {
  const models: ModelListResponse['data'] = []
  let cursor: string | null = null
  do {
    const page: ModelListResponse = await client.request<ModelListResponse>('model/list', {
      cursor,
      limit: 100,
      includeHidden: false,
    }, signal)
    models.push(...page.data)
    cursor = page.nextCursor
  } while (cursor !== null)
  return models
}
