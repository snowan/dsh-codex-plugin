import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough, Writable } from 'node:stream'
import { CodexBridgeManager } from '../lib/bridge.js'

function scriptedRuntime(script) {
  const handles = []
  return {
    handles,
    async resolveExecutable(command) { return `/resolved/${command}` },
    spawn() {
      const stdout = new PassThrough()
      let input = ''
      let complete
      let closed = false
      const done = new Promise(resolve => { complete = resolve })
      const send = message => stdout.write(`${JSON.stringify(message)}\n`)
      const stdin = new Writable({
        write(chunk, _encoding, callback) {
          input += chunk.toString()
          for (;;) {
            const newline = input.indexOf('\n')
            if (newline < 0) break
            const line = input.slice(0, newline)
            input = input.slice(newline + 1)
            if (line.trim().length > 0) script(JSON.parse(line), send)
          }
          callback()
        },
      })
      const handle = {
        pid: 7,
        stdin,
        stdout,
        stderr: undefined,
        collected: {},
        done,
        terminate() {
          if (closed) return
          closed = true
          stdout.end()
          stdin.end()
          complete({ exitCode: 0, signal: null })
        },
        async waitForExit() { return true },
      }
      handles.push(handle)
      return handle
    },
  }
}

function config() {
  return {
    codexCommand: 'codex',
    cwd: '/workspace',
    env: {},
    allowCodexNativeTools: false,
    disposeGraceMs: 100,
    contextWindow: 200_000,
    modelCacheMs: 1000,
    sessionIdleMs: 60_000,
  }
}

function userMessage(text) {
  return {
    id: `user-${text}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('streams Codex text and disjoint token usage as a DSH response', async () => {
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'gpt-test' } })
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-1' } } })
      queueMicrotask(() => {
        send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'i1', delta: 'hello' } })
        send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { totalTokens: 19, inputTokens: 12, cachedInputTokens: 4, cacheWriteInputTokens: 1, outputTokens: 7, reasoningOutputTokens: 2 } } } })
        send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } })
      })
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, config())
  const chunks = await collect(manager.stream({
    provider: 'codex-cli',
    model: 'gpt-test',
    sessionId: 'session-1',
    messages: [userMessage('hi')],
  }))
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'hello')
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage, {
    inputTokens: 7,
    outputTokens: 7,
    cacheReadTokens: 4,
    cacheWriteTokens: 1,
    reasoningTokens: 2,
  })
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(chunks.at(-1)?.reason.kind, 'stop')
  await manager.dispose()
})

test('returns a DSH tool call, accepts its result, and resumes the same Codex turn', async () => {
  let toolResponse
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-2' }, model: 'gpt-test' } })
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-2' } } })
      queueMicrotask(() => send({
        id: 900,
        method: 'item/tool/call',
        params: { threadId: 'thread-2', turnId: 'turn-2', callId: 'call-1', namespace: null, tool: 'Read', arguments: { path: 'package.json' } },
      }))
    }
    if (message.id === 900 && message.result !== undefined) {
      toolResponse = message.result
      queueMicrotask(() => {
        send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-2', turnId: 'turn-2', itemId: 'i2', delta: 'version 1.0.0' } })
        send({ method: 'turn/completed', params: { threadId: 'thread-2', turn: { id: 'turn-2', status: 'completed', error: null } } })
      })
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, config())
  const first = await collect(manager.stream({
    provider: 'codex-cli',
    model: 'gpt-test',
    sessionId: 'session-tool',
    tools: [{ name: 'Read', description: 'Read a file', parameters: { type: 'object' } }],
    messages: [userMessage('read package.json')],
  }))
  assert.equal(first.at(-1)?.reason.kind, 'tool-calls')
  assert.equal(first.find(chunk => chunk.type === 'tool-call-delta')?.name, 'Read')

  const second = await collect(manager.stream({
    provider: 'codex-cli',
    model: 'gpt-test',
    sessionId: 'session-tool',
    tools: [{ name: 'Read', description: 'Read a file', parameters: { type: 'object' } }],
    messages: [
      userMessage('read package.json'),
      {
        id: 'tool-result',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '{"version":"1.0.0"}' }], isError: false }],
      },
    ],
  }))
  assert.deepEqual(toolResponse, {
    contentItems: [{ type: 'inputText', text: '{"version":"1.0.0"}' }],
    success: true,
  })
  assert.equal(second.find(chunk => chunk.type === 'text-delta')?.text, 'version 1.0.0')
  assert.equal(second.at(-1)?.reason.kind, 'stop')
  assert.equal(runtime.handles.length, 1)
  await manager.dispose()
})

test('discovers every model-list page and caches the result', async () => {
  let listCalls = 0
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'model/list') {
      listCalls += 1
      const second = message.params.cursor === 'next'
      send({
        id: message.id,
        result: {
          data: [{
            id: second ? 'gpt-b' : 'gpt-a',
            model: second ? 'gpt-b' : 'gpt-a',
            displayName: second ? 'B' : 'A',
            description: '',
            hidden: false,
            isDefault: !second,
            inputModalities: ['text'],
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [],
          }],
          nextCursor: second ? null : 'next',
        },
      })
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, config())
  assert.deepEqual((await manager.listModels()).map(model => model.id), ['gpt-a', 'gpt-b'])
  assert.deepEqual((await manager.listModels()).map(model => model.id), ['gpt-a', 'gpt-b'])
  assert.equal(listCalls, 2)
  assert.equal(runtime.handles.length, 1)
  await manager.dispose()
})

test('starts a new App Server when a DSH session changes its tool catalog', async () => {
  let processNumber = 0
  const runtime = {
    handles: [],
    async resolveExecutable(command) { return command },
    spawn() {
      processNumber += 1
      const thisProcess = processNumber
      return scriptedRuntime((message, send) => {
        if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
        if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: `thread-${thisProcess}` }, model: 'gpt-test' } })
        if (message.method === 'turn/start') {
          send({ id: message.id, result: { turn: { id: `turn-${thisProcess}` } } })
          queueMicrotask(() => send({ method: 'turn/completed', params: { threadId: `thread-${thisProcess}`, turn: { id: `turn-${thisProcess}`, status: 'completed', error: null } } }))
        }
      }).spawn()
    },
  }
  const manager = new CodexBridgeManager(runtime, undefined, config())
  await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'changing-tools', messages: [userMessage('one')], tools: [],
  }))
  await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'changing-tools', messages: [userMessage('two')],
    tools: [{ name: 'Read', description: 'read', parameters: { type: 'object' } }],
  }))
  assert.equal(processNumber, 2)
  await manager.dispose()
})
