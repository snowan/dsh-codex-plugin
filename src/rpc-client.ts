import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { AsyncQueue } from './async-queue.js'
import {
  hasId,
  hasMethod,
  isRecord,
  type RequestId,
  type RpcFailure,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
} from './protocol.js'

export type AppServerEvent =
  | { type: 'notification'; value: RpcNotification }
  | { type: 'request'; value: RpcRequest }
  | { type: 'closed'; exitCode: number | null; signal: NodeJS.Signals | null }
  | { type: 'protocol-error'; error: Error }

export interface AppServerCloseOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}

export class RpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcResponseError'
  }
}

export class AppServerClient {
  readonly #handle: SubprocessHandle
  readonly #events = new AsyncQueue<AppServerEvent>()
  readonly #pending = new Map<RequestId, PendingRequest>()
  #nextId = 1
  #buffer = ''
  #closed = false
  #closeOutcome: AppServerCloseOutcome | undefined

  constructor(handle: SubprocessHandle) {
    if (handle.stdin === undefined || handle.stdout === undefined) {
      throw new Error('Codex App Server requires piped stdin and stdout')
    }
    this.#handle = handle
    handle.stdout.setEncoding('utf8')
    handle.stdout.on('data', (chunk: string) => this.#accept(chunk))
    handle.stdout.on('error', error => this.#failProtocol(error))
    handle.done.then(
      outcome => this.#close(outcome.exitCode, outcome.signal),
      error => this.#failProtocol(error instanceof Error ? error : new Error(String(error))),
    )
  }

  get pid(): number {
    return this.#handle.pid
  }

  get closed(): boolean {
    return this.#closed
  }

  get closeOutcome(): Readonly<AppServerCloseOutcome> | undefined {
    return this.#closeOutcome === undefined ? undefined : { ...this.#closeOutcome }
  }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Codex App Server is closed'))
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id)
        reject(signal?.reason)
      }
      this.#pending.set(id, {
        resolve: result => resolve(result as T),
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.#write({ id, method, params })
      } catch (error) {
        this.#pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params })
  }

  respond(id: RequestId, result: unknown): void {
    this.#write({ id, result })
  }

  respondError(id: RequestId, code: number, message: string, data?: unknown): void {
    this.#write({ id, error: data === undefined ? { code, message } : { code, message, data } })
  }

  nextEvent(signal?: AbortSignal): Promise<AppServerEvent> {
    return this.#events.take(signal)
  }

  pollEvent(): AppServerEvent | undefined {
    return this.#events.poll()
  }

  terminate(): void {
    this.#handle.terminate()
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> {
    return this.#handle.waitForExit(signal)
  }

  #write(message: RpcMessage): void {
    if (this.#closed || this.#handle.stdin === undefined) {
      throw new Error('Codex App Server is closed')
    }
    this.#handle.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #accept(chunk: string): void {
    this.#buffer += chunk
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.length === 0) continue
      try {
        this.#route(JSON.parse(line) as unknown)
      } catch (error) {
        this.#events.push({
          type: 'protocol-error',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    }
  }

  #route(message: unknown): void {
    if (!isRecord(message)) throw new Error('Codex emitted a non-object JSON-RPC message')
    if (hasMethod(message)) {
      if (hasId(message)) {
        this.#events.push({ type: 'request', value: message })
      } else {
        this.#events.push({ type: 'notification', value: message })
      }
      return
    }
    if (!hasId(message)) throw new Error('Codex emitted JSON-RPC without method or id')
    const pending = this.#pending.get(message.id)
    if (pending === undefined) return
    this.#pending.delete(message.id)
    pending.cleanup()
    if ('error' in message && isRecord(message.error)) {
      const failure = message as unknown as RpcFailure
      pending.reject(new RpcResponseError(failure.error.code, failure.error.message, failure.error.data))
      return
    }
    pending.resolve('result' in message ? message.result : undefined)
  }

  #failProtocol(error: Error): void {
    this.#events.push({ type: 'protocol-error', error })
    this.#close(null, null)
  }

  #close(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.#closed) return
    this.#closed = true
    this.#closeOutcome = { exitCode, signal }
    const error = new Error(`Codex App Server closed (exit=${String(exitCode)}, signal=${String(signal)})`)
    for (const pending of this.#pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.#pending.clear()
    this.#events.push({ type: 'closed', exitCode, signal })
  }
}
