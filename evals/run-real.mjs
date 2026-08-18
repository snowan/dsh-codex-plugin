#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { CodexBridgeManager } from '../lib/bridge.js'

class NativeRuntime {
  async resolveExecutable(command) {
    return command
  }

  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString()}`.slice(-65_536) })
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    return {
      pid: child.pid ?? -1,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: undefined,
      collected: {
        stderr: {
          readFrom: () => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }),
        },
      },
      done,
      terminate: () => child.kill('SIGTERM'),
      async waitForExit(signal) {
        if (child.exitCode !== null || child.signalCode !== null) return true
        return new Promise(resolve => {
          const onClose = () => { cleanup(); resolve(true) }
          const onAbort = () => { cleanup(); resolve(false) }
          const cleanup = () => {
            child.removeListener('close', onClose)
            signal?.removeEventListener('abort', onAbort)
          }
          child.once('close', onClose)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      },
    }
  }
}

function userMessage(id, text) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function visibleText(chunks) {
  return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}

const model = process.env.DSH_CODEX_EVAL_MODEL ?? 'gpt-5.6-terra'
const manager = new CodexBridgeManager(new NativeRuntime(), undefined, {
  codexCommand: process.env.DSH_CODEX_COMMAND ?? 'codex',
  cwd: process.cwd(),
  env: {},
  allowCodexNativeTools: false,
  disposeGraceMs: 3_000,
  contextWindow: 200_000,
  modelCacheMs: 60_000,
  sessionIdleMs: 60_000,
})

const report = {
  runAt: new Date().toISOString(),
  model,
  scenarios: [],
}

try {
  const models = await manager.listModels()
  report.models = models.map(item => item.id)

  const basicStartedAt = performance.now()
  const basic = await collect(manager.stream({
    provider: 'codex-cli',
    model,
    sessionId: 'eval-basic',
    cwd: process.cwd(),
    system: 'Follow the output format exactly.',
    messages: [userMessage('basic-user', 'Reply with exactly: DSH_CODEX_OK')],
  }))
  report.scenarios.push({
    name: 'basic-stream',
    passed: visibleText(basic).trim() === 'DSH_CODEX_OK',
    durationMs: Math.round(performance.now() - basicStartedAt),
    output: visibleText(basic),
    finish: basic.at(-1)?.reason?.kind,
    usage: basic.find(chunk => chunk.type === 'usage')?.usage,
  })

  const tools = [{
    name: 'fixture_lookup',
    description: 'Look up the deterministic evaluation value for a key.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
  }]
  const toolStartedAt = performance.now()
  const initialUser = userMessage('tool-user', 'Use fixture_lookup with key "alpha", then reply with exactly the value returned by the tool.')
  const first = await collect(manager.stream({
    provider: 'codex-cli',
    model,
    sessionId: 'eval-tool',
    cwd: process.cwd(),
    tools,
    messages: [initialUser],
  }))
  const toolCall = first.find(chunk => chunk.type === 'tool-call-delta')
  let final = []
  if (toolCall !== undefined) {
    final = await collect(manager.stream({
      provider: 'codex-cli',
      model,
      sessionId: 'eval-tool',
      cwd: process.cwd(),
      tools,
      messages: [
        initialUser,
        {
          id: 'tool-result',
          role: 'user',
          source: { kind: 'tool', callId: toolCall.id },
          content: [{
            type: 'tool-result',
            toolCallId: toolCall.id,
            content: [{ type: 'text', text: 'ALPHA_42' }],
            isError: false,
          }],
        },
      ],
    }))
  }
  report.scenarios.push({
    name: 'dsh-tool-round-trip',
    passed: toolCall?.name === 'fixture_lookup' && visibleText(final).trim() === 'ALPHA_42',
    durationMs: Math.round(performance.now() - toolStartedAt),
    tool: toolCall === undefined ? null : { name: toolCall.name, arguments: toolCall.argumentsDelta },
    firstFinish: first.at(-1)?.reason?.kind,
    output: visibleText(final),
    finalFinish: final.at(-1)?.reason?.kind,
  })
} finally {
  await manager.dispose()
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.scenarios.some(scenario => !scenario.passed)) process.exitCode = 1
