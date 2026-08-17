import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  ToolResultBlock,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'

export interface CodexUserText {
  type: 'text'
  text: string
  text_elements: []
}

export interface CodexUserImage {
  type: 'image'
  url: string
}

export type CodexUserInput = CodexUserText | CodexUserImage

export interface CodexDynamicTool {
  type: 'function'
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface CodexToolOutputText {
  type: 'inputText'
  text: string
}

export interface CodexToolOutputImage {
  type: 'inputImage'
  imageUrl: string
}

export type CodexToolOutput = CodexToolOutputText | CodexToolOutputImage

const READ_TOOL_GUIDANCE = [
  'DSH adapter guidance: use this tool only for a path that is expected to exist.',
  'When a path is optional or one of several candidates, first check existence with glob or a non-error bash test (when available), then read only confirmed matches.',
  'A missing path is a failed DSH action and is shown as an error to the user.',
].join(' ')

function dynamicToolDescription(tool: ToolSchema): string {
  if (!/^read(?:_file)?$/iu.test(tool.name)) return tool.description
  return `${tool.description}\n\n${READ_TOOL_GUIDANCE}`
}

export function dynamicTools(tools: readonly ToolSchema[] | undefined): CodexDynamicTool[] {
  return (tools ?? []).map((tool) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(tool.name)) {
      throw new Error(`DSH tool name "${tool.name}" is not accepted by Codex dynamic tools`)
    }
    return {
      type: 'function',
      name: tool.name,
      description: dynamicToolDescription(tool),
      inputSchema: structuredClone(tool.parameters),
    }
  })
}

export function toolSignature(tools: readonly ToolSchema[] | undefined): string {
  return JSON.stringify(dynamicTools(tools))
}

async function imageUrl(
  block: Extract<ContentBlock, { type: 'image' }>,
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (attachments === undefined) {
    throw new Error('Codex image input requires the DSH attachment service')
  }
  const stored = await attachments.readImage(block.attachment, signal)
  return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return `[reasoning summary] ${block.text}`
    case 'image':
      return `[image: ${block.attachment.name ?? block.attachment.attachmentId}]`
    case 'tool-call':
      return `[tool call ${block.name} id=${block.id}] ${block.arguments}`
    case 'tool-result':
      return `[tool result id=${block.toolCallId}${block.isError === true ? ' error' : ''}] ${block.content.map(blockText).join('\n')}`
    default:
      return `[unsupported content block ${(block as { type?: unknown }).type as string}]`
  }
}

function messageText(message: Message): string {
  return `<message role="${message.role}" source="${message.source.kind}">\n${message.content.map(blockText).join('\n')}\n</message>`
}

async function blocksToInput(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<CodexUserInput[]> {
  const result: CodexUserInput[] = []
  let text = ''
  const flush = (): void => {
    if (text.length === 0) return
    result.push({ type: 'text', text, text_elements: [] })
    text = ''
  }
  for (const block of blocks) {
    if (block.type === 'image') {
      flush()
      result.push({ type: 'image', url: await imageUrl(block, attachments, signal) })
    } else {
      text += `${text.length === 0 ? '' : '\n'}${blockText(block)}`
    }
  }
  flush()
  return result
}

function latestConversationalMessage(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'user'
      && !message.content.some(block => block.type === 'tool-result')) return message
  }
  return undefined
}

export async function firstTurnInput(
  options: GenerateOptions,
  attachments: AttachmentStore | undefined,
): Promise<CodexUserInput[]> {
  const conversational = options.messages.filter(message => message.source.kind !== 'plugin')
  if (conversational.length <= 1) {
    const latest = latestConversationalMessage(options.messages) ?? options.messages.at(-1)
    if (latest !== undefined) return blocksToInput(latest.content, attachments, options.signal)
  }

  const transcript = conversational.map(messageText).join('\n')
  const latest = latestConversationalMessage(options.messages)
  const inputs: CodexUserInput[] = [{
    type: 'text',
    text: [
      'The DSH session is being reconstructed. Treat this transcript as prior conversation state, then answer the final user message.',
      '<dsh_transcript>',
      transcript,
      '</dsh_transcript>',
    ].join('\n'),
    text_elements: [],
  }]
  if (latest !== undefined) {
    const images = latest.content.filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
    for (const image of images) inputs.push({ type: 'image', url: await imageUrl(image, attachments, options.signal) })
  }
  return inputs
}

export async function nextTurnInput(
  options: GenerateOptions,
  attachments: AttachmentStore | undefined,
): Promise<CodexUserInput[]> {
  const latest = latestConversationalMessage(options.messages)
  if (latest === undefined) throw new Error('Codex continuation has no new user message')
  return blocksToInput(latest.content, attachments, options.signal)
}

export function findToolResults(
  messages: readonly Message[],
  pendingCallIds: ReadonlySet<string>,
): ToolResultBlock[] {
  const found = new Map<string, ToolResultBlock>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-result' && pendingCallIds.has(block.toolCallId)) {
        found.set(block.toolCallId, block)
      }
    }
  }
  return [...found.values()]
}

export async function toolOutput(
  result: ToolResultBlock,
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<CodexToolOutput[]> {
  const outputs: CodexToolOutput[] = []
  let text = ''
  const flush = (): void => {
    if (text.length === 0) return
    outputs.push({ type: 'inputText', text })
    text = ''
  }
  for (const block of result.content) {
    if (block.type === 'image') {
      flush()
      outputs.push({ type: 'inputImage', imageUrl: await imageUrl(block, attachments, signal) })
    } else {
      text += `${text.length === 0 ? '' : '\n'}${blockText(block)}`
    }
  }
  flush()
  if (outputs.length === 0) outputs.push({ type: 'inputText', text: '(tool returned no content)' })
  return outputs
}
