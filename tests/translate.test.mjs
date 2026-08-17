import assert from 'node:assert/strict'
import test from 'node:test'
import { dynamicTools, findToolResults, firstTurnInput, toolOutput, toolSignature } from '../lib/translate.js'

test('maps DSH tool schemas without changing names or JSON Schema and makes read failure semantics explicit', () => {
  const tools = [{
    name: 'Read',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  }]
  const mapped = dynamicTools(tools)
  assert.match(mapped[0].description, /optional or one of several candidates/u)
  assert.deepEqual(mapped, [{
    type: 'function',
    name: 'Read',
    description: mapped[0].description,
    inputSchema: tools[0].parameters,
  }])
  assert.equal(toolSignature(tools), JSON.stringify(dynamicTools(tools)))
})

test('does not rewrite non-read DSH tool descriptions', () => {
  const tools = [{
    name: 'glob',
    description: 'Find matching files',
    parameters: { type: 'object' },
  }]
  assert.equal(dynamicTools(tools)[0].description, 'Find matching files')
})

test('finds only results matching pending Codex call ids', () => {
  const messages = [{
    id: 'm1',
    role: 'user',
    source: { kind: 'tool', callId: 'call-1' },
    content: [{
      type: 'tool-result',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }],
  }]
  assert.equal(findToolResults(messages, new Set(['call-1'])).length, 1)
  assert.equal(findToolResults(messages, new Set(['different'])).length, 0)
})

test('rejects tool names outside Codex dynamic-tool constraints', () => {
  assert.throws(() => dynamicTools([{
    name: 'bad/tool',
    description: 'not valid',
    parameters: { type: 'object' },
  }]), /not accepted/u)
})

test('loads DSH image attachments as Codex data URLs', async () => {
  const attachments = {
    async readImage(ref) {
      return { ref, data: Uint8Array.from([1, 2, 3]) }
    },
  }
  const attachment = {
    attachmentId: 'image-1',
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
  }
  const input = await firstTurnInput({
    provider: 'codex-cli',
    model: 'gpt-test',
    messages: [{
      id: 'm-image',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'inspect' }, { type: 'image', attachment }],
    }],
  }, attachments)
  assert.deepEqual(input, [
    { type: 'text', text: 'inspect', text_elements: [] },
    { type: 'image', url: 'data:image/png;base64,AQID' },
  ])
})

test('maps an errored DSH tool result to content without hiding the error text', async () => {
  const output = await toolOutput({
    type: 'tool-result',
    toolCallId: 'call-error',
    content: [{ type: 'text', text: 'file missing' }],
    isError: true,
  }, undefined)
  assert.deepEqual(output, [{ type: 'inputText', text: 'file missing' }])
})
