import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough, Writable } from 'node:stream'
import { CodexBridgeManager, CodexSessionLostError } from '../lib/bridge.js'

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
      const close = (exitCode = 0) => {
        if (closed) return
        closed = true
        stdout.end()
        stdin.end()
        complete({ exitCode, signal: null })
      }
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
        terminate: () => close(),
        crash: () => close(1),
        isClosed: () => closed,
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

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return true
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

test('reports a failed DSH tool result to Codex and resumes the same turn', async () => {
  let threadStart
  let toolResponse
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') {
      threadStart = message.params
      send({ id: message.id, result: { thread: { id: 'thread-error' }, model: 'gpt-test' } })
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-error' } } })
      queueMicrotask(() => send({
        id: 901,
        method: 'item/tool/call',
        params: { threadId: 'thread-error', turnId: 'turn-error', callId: 'call-error', namespace: null, tool: 'read', arguments: { file_path: 'missing' } },
      }))
    }
    if (message.id === 901 && message.result !== undefined) {
      toolResponse = message.result
      queueMicrotask(() => {
        send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-error', turnId: 'turn-error', itemId: 'i-error', delta: 'The optional file is absent.' } })
        send({ method: 'turn/completed', params: { threadId: 'thread-error', turn: { id: 'turn-error', status: 'completed', error: null } } })
      })
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, config())
  const tools = [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }]
  const first = await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'session-error', tools,
    messages: [userMessage('inspect optional config')],
  }))
  assert.equal(first.at(-1)?.reason.kind, 'tool-calls')

  const second = await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'session-error', tools,
    messages: [
      userMessage('inspect optional config'),
      {
        id: 'tool-error',
        role: 'user',
        source: { kind: 'tool', callId: 'call-error' },
        content: [{ type: 'tool-result', toolCallId: 'call-error', content: [{ type: 'text', text: 'Error: not found' }], isError: true }],
      },
    ],
  }))
  assert.match(threadStart.developerInstructions, /Do not use a read tool to test/u)
  assert.match(threadStart.dynamicTools[0].description, /failed DSH action/u)
  assert.deepEqual(toolResponse, {
    contentItems: [{ type: 'inputText', text: 'Error: not found' }],
    success: false,
  })
  assert.equal(second.find(chunk => chunk.type === 'text-delta')?.text, 'The optional file is absent.')
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

test('starts a fresh App Server when the retained client closed between turns', async () => {
  const runtime = scriptedRuntime((message, send) => {
    const processNumber = runtime.handles.length
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: `thread-recovery-${processNumber}` }, model: 'gpt-test' } })
    }
    if (message.method === 'turn/start') {
      const turnId = `turn-recovery-${processNumber}`
      send({ id: message.id, result: { turn: { id: turnId } } })
      queueMicrotask(() => {
        send({ method: 'item/agentMessage/delta', params: { threadId: `thread-recovery-${processNumber}`, turnId, itemId: `i-${processNumber}`, delta: `process-${processNumber}` } })
        send({ method: 'turn/completed', params: { threadId: `thread-recovery-${processNumber}`, turn: { id: turnId, status: 'completed', error: null } } })
      })
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, config())
  const first = await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'closed-between-turns', messages: [userMessage('one')],
  }))
  assert.equal(first.find(chunk => chunk.type === 'text-delta')?.text, 'process-1')

  runtime.handles[0].crash()
  await new Promise(resolve => setImmediate(resolve))

  const second = await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'closed-between-turns', messages: [userMessage('two')],
  }))
  assert.equal(second.find(chunk => chunk.type === 'text-delta')?.text, 'process-2')
  assert.equal(runtime.handles.length, 2)
  await manager.dispose()
})

test('invalidates a closed pending-tool session with a stable session-loss error', async () => {
  const runtime = scriptedRuntime((message, send) => {
    const processNumber = runtime.handles.length
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: `thread-pending-${processNumber}` }, model: 'gpt-test' } })
    }
    if (message.method === 'turn/start') {
      const turnId = `turn-pending-${processNumber}`
      send({ id: message.id, result: { turn: { id: turnId } } })
      if (processNumber === 1) {
        queueMicrotask(() => send({
          id: 910,
          method: 'item/tool/call',
          params: { threadId: 'thread-pending-1', turnId, callId: 'call-lost', namespace: null, tool: 'Read', arguments: { path: 'package.json' } },
        }))
      } else {
        queueMicrotask(() => send({
          method: 'turn/completed',
          params: { threadId: `thread-pending-${processNumber}`, turn: { id: turnId, status: 'completed', error: null } },
        }))
      }
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, config())
  const tools = [{ name: 'Read', description: 'Read a file', parameters: { type: 'object' } }]
  const first = await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'pending-crash', tools, messages: [userMessage('read')],
  }))
  assert.equal(first.at(-1)?.reason.kind, 'tool-calls')

  runtime.handles[0].crash()
  await new Promise(resolve => setImmediate(resolve))

  await assert.rejects(
    collect(manager.stream({
      provider: 'codex-cli', model: 'gpt-test', sessionId: 'pending-crash', tools,
      messages: [
        userMessage('read'),
        {
          id: 'lost-result',
          role: 'user',
          source: { kind: 'tool', callId: 'call-lost' },
          content: [{ type: 'tool-result', toolCallId: 'call-lost', content: [{ type: 'text', text: 'late' }], isError: false }],
        },
      ],
    })),
    error => {
      assert.equal(error instanceof CodexSessionLostError, true)
      assert.equal(error.code, 'CODEX_SESSION_LOST')
      assert.deepEqual(error.pendingCallIds, ['call-lost'])
      assert.equal(error.exitCode, 1)
      return true
    },
  )

  const recovered = await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'pending-crash', tools, messages: [userMessage('retry cleanly')],
  }))
  assert.equal(recovered.at(-1)?.reason.kind, 'stop')
  assert.equal(runtime.handles.length, 2)
  await manager.dispose()
})

test('waits for interrupt acknowledgement and terminal completion before reusing a session', async () => {
  const abort = new AbortController()
  let turnNumber = 0
  let interruptCompleted = false
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-interrupt' }, model: 'gpt-test' } })
    if (message.method === 'turn/start') {
      turnNumber += 1
      const turnId = `turn-interrupt-${turnNumber}`
      send({ id: message.id, result: { turn: { id: turnId } } })
      if (turnNumber === 1) queueMicrotask(() => abort.abort(new Error('cancelled by test')))
      else queueMicrotask(() => send({
        method: 'turn/completed',
        params: { threadId: 'thread-interrupt', turn: { id: turnId, status: 'completed', error: null } },
      }))
    }
    if (message.method === 'turn/interrupt') {
      setTimeout(() => {
        send({ id: message.id, result: {} })
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-interrupt', turn: { id: 'turn-interrupt-1', status: 'interrupted', error: null } },
        })
        interruptCompleted = true
      }, 20)
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, config())
  const first = await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'interrupt-ack', signal: abort.signal, messages: [userMessage('one')],
  }))
  assert.equal(first.at(-1)?.reason.kind, 'aborted')
  assert.equal(interruptCompleted, true)

  const second = await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'interrupt-ack', messages: [userMessage('two')],
  }))
  assert.equal(second.at(-1)?.reason.kind, 'stop')
  assert.equal(runtime.handles.length, 1)
  await manager.dispose()
})

test('invalidates an App Server that does not acknowledge interruption', async () => {
  const abort = new AbortController()
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-timeout' }, model: 'gpt-test' } })
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-timeout' } } })
      queueMicrotask(() => abort.abort(new Error('cancelled by test')))
    }
    // Deliberately leave turn/interrupt unanswered.
  })
  const manager = new CodexBridgeManager(runtime, undefined, { ...config(), disposeGraceMs: 20 })
  const startedAt = performance.now()
  let testDeadline
  const deadline = new Promise((_, reject) => {
    testDeadline = setTimeout(() => reject(new Error('interrupt timeout test exceeded 500ms')), 500)
  })
  let chunks
  try {
    chunks = await Promise.race([
      collect(manager.stream({
        provider: 'codex-cli', model: 'gpt-test', sessionId: 'interrupt-timeout', signal: abort.signal, messages: [userMessage('one')],
      })),
      deadline,
    ])
  } finally {
    clearTimeout(testDeadline)
  }
  const elapsed = performance.now() - startedAt
  assert.equal(chunks.at(-1)?.reason.kind, 'aborted')
  assert.equal(runtime.handles[0].isClosed(), true)
  assert.equal(elapsed >= 15, true)
  assert.equal(elapsed < 500, true)
  await manager.dispose()
})

test('invalidates the App Server when abort happens before turn/start returns an id', async () => {
  const abort = new AbortController()
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-startup-abort' }, model: 'gpt-test' } })
    if (message.method === 'turn/start') queueMicrotask(() => abort.abort(new Error('cancelled before turn id')))
  })
  const manager = new CodexBridgeManager(runtime, undefined, config())
  const chunks = await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'startup-abort', signal: abort.signal, messages: [userMessage('one')],
  }))
  assert.equal(chunks.at(-1)?.reason.kind, 'aborted')
  assert.equal(runtime.handles[0].isClosed(), true)
  await manager.dispose()
})

test('terminates an idle session at its deadline without requiring another stream', async () => {
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-idle' }, model: 'gpt-test' } })
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-idle' } } })
      queueMicrotask(() => send({
        method: 'turn/completed',
        params: { threadId: 'thread-idle', turn: { id: 'turn-idle', status: 'completed', error: null } },
      }))
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, { ...config(), sessionIdleMs: 30 })
  await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'idle-deadline', messages: [userMessage('one')],
  }))
  assert.equal(runtime.handles[0].isClosed(), false)
  assert.equal(await waitFor(() => runtime.handles[0].isClosed()), true)
  await manager.dispose()
})

test('rearms the idle deadline when a retained session is reused', async () => {
  let turnNumber = 0
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-rearm' }, model: 'gpt-test' } })
    if (message.method === 'turn/start') {
      turnNumber += 1
      const turnId = `turn-rearm-${turnNumber}`
      send({ id: message.id, result: { turn: { id: turnId } } })
      queueMicrotask(() => send({
        method: 'turn/completed',
        params: { threadId: 'thread-rearm', turn: { id: turnId, status: 'completed', error: null } },
      }))
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, { ...config(), sessionIdleMs: 120 })
  await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'idle-rearm', messages: [userMessage('one')],
  }))
  await new Promise(resolve => setTimeout(resolve, 80))
  await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'idle-rearm', messages: [userMessage('two')],
  }))
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(runtime.handles[0].isClosed(), false)
  assert.equal(runtime.handles.length, 1)
  assert.equal(await waitFor(() => runtime.handles[0].isClosed()), true)
  await manager.dispose()
})

test('manager disposal terminates retained sessions and cancels their idle work', async () => {
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: `thread-${runtime.handles.length}` }, model: 'gpt-test' } })
    if (message.method === 'turn/start') {
      const turnId = `turn-${runtime.handles.length}`
      send({ id: message.id, result: { turn: { id: turnId } } })
      queueMicrotask(() => send({
        method: 'turn/completed',
        params: { threadId: `thread-${runtime.handles.length}`, turn: { id: turnId, status: 'completed', error: null } },
      }))
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, { ...config(), sessionIdleMs: 30 })
  await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'dispose-a', messages: [userMessage('a')],
  }))
  await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'dispose-b', messages: [userMessage('b')],
  }))
  await manager.dispose()
  assert.equal(runtime.handles.length, 2)
  assert.deepEqual(runtime.handles.map(handle => handle.isClosed()), [true, true])
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(runtime.handles.map(handle => handle.isClosed()), [true, true])
})

test('prefers the request workspace and falls back to the configured cwd', async () => {
  const threadCwds = []
  let turnNumber = 0
  const runtime = scriptedRuntime((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
    if (message.method === 'thread/start') {
      threadCwds.push(message.params.cwd)
      send({ id: message.id, result: { thread: { id: `thread-workspace-${threadCwds.length}` }, model: 'gpt-test' } })
    }
    if (message.method === 'turn/start') {
      turnNumber += 1
      const turnId = `turn-workspace-${turnNumber}`
      send({ id: message.id, result: { turn: { id: turnId } } })
      queueMicrotask(() => send({
        method: 'turn/completed',
        params: { threadId: message.params.threadId, turn: { id: turnId, status: 'completed', error: null } },
      }))
    }
  })
  const manager = new CodexBridgeManager(runtime, undefined, config())
  await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'workspace-specific', cwd: '/sessions/a', messages: [userMessage('a')],
  }))
  await collect(manager.stream({
    provider: 'codex-cli', model: 'gpt-test', sessionId: 'workspace-fallback', messages: [userMessage('b')],
  }))
  assert.deepEqual(threadCwds, ['/sessions/a', '/workspace'])
  await manager.dispose()
})
