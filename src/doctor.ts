#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface Check {
  name: string
  ok: boolean
  detail: string
}

async function command(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, { timeout: 15_000 })
  return `${result.stdout}${result.stderr}`.trim()
}

async function appServerProbe(codexCommand: string): Promise<{ userAgent: string; models: string[] }> {
  const child = spawn(codexCommand, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_192) })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  child.on('error', error => rejectPending(error))
  child.on('close', (code, signal) => rejectPending(new Error(
    `Codex App Server closed before the probe completed (exit=${String(code)}, signal=${String(signal)})`,
  )))
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }
      if (message.id === undefined) continue
      const request = pending.get(message.id)
      if (request === undefined) continue
      pending.delete(message.id)
      if (message.error !== undefined) request.reject(new Error(message.error.message ?? 'JSON-RPC error'))
      else request.resolve(message.result)
    }
  })
  const send = <T>(id: number, method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
    pending.set(id, { resolve: value => resolve(value as T), reject })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  const timeout = setTimeout(() => {
    rejectPending(new Error('Codex App Server probe timed out after 20 seconds'))
    child.kill('SIGTERM')
  }, 20_000)
  try {
    const initialized = await send<{ userAgent: string }>(1, 'initialize', {
      clientInfo: { name: 'dsh-codex-doctor', title: 'DSH Codex Doctor', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    const models = await send<{ data: Array<{ id: string }> }>(2, 'model/list', {
      cursor: null,
      limit: 100,
      includeHidden: false,
    })
    return { userAgent: initialized.userAgent, models: models.data.map(model => model.id) }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.length === 0 ? '' : `; stderr: ${stderr}`}`)
  } finally {
    clearTimeout(timeout)
    child.kill('SIGTERM')
  }
}

export async function runDoctor(codexCommand = process.env.DSH_CODEX_COMMAND ?? 'codex'): Promise<Check[]> {
  const checks: Check[] = []
  try {
    checks.push({ name: 'Codex CLI', ok: true, detail: await command(codexCommand, ['--version']) })
  } catch (error) {
    checks.push({ name: 'Codex CLI', ok: false, detail: error instanceof Error ? error.message : String(error) })
    return checks
  }
  try {
    const status = await command(codexCommand, ['login', 'status'])
    checks.push({ name: 'ChatGPT login', ok: /logged in/iu.test(status), detail: status })
  } catch (error) {
    checks.push({ name: 'ChatGPT login', ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
  try {
    const probe = await appServerProbe(codexCommand)
    checks.push({
      name: 'App Server',
      ok: probe.models.length > 0,
      detail: `${probe.userAgent}; ${probe.models.length} models (${probe.models.slice(0, 6).join(', ')})`,
    })
  } catch (error) {
    checks.push({ name: 'App Server', ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
  return checks
}

async function main(): Promise<void> {
  const checks = await runDoctor()
  for (const check of checks) process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}\n`)
  if (checks.some(check => !check.ok)) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
