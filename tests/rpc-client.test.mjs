import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough, Writable } from 'node:stream'
import { AppServerClient, RpcResponseError } from '../lib/rpc-client.js'

function fakeHandle(onMessage) {
  const stdout = new PassThrough()
  let input = ''
  let finish
  const done = new Promise(resolve => { finish = resolve })
  let closed = false
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString()
      for (;;) {
        const newline = input.indexOf('\n')
        if (newline < 0) break
        const line = input.slice(0, newline)
        input = input.slice(newline + 1)
        if (line.trim().length > 0) onMessage(JSON.parse(line), message => stdout.write(`${JSON.stringify(message)}\n`))
      }
      callback()
    },
  })
  return {
    pid: 42,
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
      finish({ exitCode: 0, signal: null })
    },
    async waitForExit() { return true },
  }
}

test('routes responses, notifications, and server requests independently', async () => {
  const handle = fakeHandle((message, send) => {
    if (message.method === 'echo') send({ id: message.id, result: message.params })
    if (message.method === 'fail') send({ id: message.id, error: { code: 77, message: 'nope' } })
  })
  const client = new AppServerClient(handle)
  assert.deepEqual(await client.request('echo', { value: 3 }), { value: 3 })
  await assert.rejects(client.request('fail', {}), error => error instanceof RpcResponseError && error.code === 77)

  handle.stdout.write(`${JSON.stringify({ method: 'notice', params: { n: 1 } })}\n`)
  handle.stdout.write(`${JSON.stringify({ id: 900, method: 'item/tool/call', params: { callId: 'c1' } })}\n`)
  assert.deepEqual(await client.nextEvent(), {
    type: 'notification',
    value: { method: 'notice', params: { n: 1 } },
  })
  assert.deepEqual(await client.nextEvent(), {
    type: 'request',
    value: { id: 900, method: 'item/tool/call', params: { callId: 'c1' } },
  })
  client.terminate()
})

test('rejects a pending request when the process closes', async () => {
  const handle = fakeHandle(() => undefined)
  const client = new AppServerClient(handle)
  const pending = client.request('never', {})
  client.terminate()
  await assert.rejects(pending, /closed/u)
})

test('parses a JSON-RPC response split across stdout chunks', async () => {
  const handle = fakeHandle((message) => {
    if (message.method !== 'split') return
    handle.stdout.write(`{"id":${message.id},"res`)
    queueMicrotask(() => handle.stdout.write('ult":{"ok":true}}\n'))
  })
  const client = new AppServerClient(handle)
  assert.deepEqual(await client.request('split', {}), { ok: true })
  client.terminate()
})
