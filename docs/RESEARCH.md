# Research notes

This implementation was designed from public protocols and independent
experiments. No third-party DSH Codex plugin source was used as a code base.

## Sources and learnings

### DeepSeek Harness

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) defines a
  provider-neutral `LlmAdapter`, immutable DSH messages, streaming chunks,
  dynamic tool schemas, and a managed subprocess service.
- Its bundle/profile design uses a package `dsh.bundle.patch` declaration and
  `cordis.patch.yml`; a later bundle can register a provider and replace the
  `agent-default-model` row without modifying DSH.
- The in-tree Codex subagent demonstrates that App Server is the supported
  Codex integration boundary, but a primary-model adapter has a different
  continuation problem: tool execution occurs outside Codex in DSH's loop.

### OpenAI Codex

- [Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
  specifies bidirectional JSON-RPC without a `jsonrpc` header and newline JSON
  framing over stdio.
- The initialize handshake must complete before model, thread, or turn calls.
- `codex app-server generate-ts --experimental` and
  `generate-json-schema --experimental` produce schemas that match the exact
  installed CLI version. Those generated schemas were used as a compatibility
  specification, not copied into this repository.
- Dynamic tools use a server-to-client `item/tool/call` request. Responding to
  that same request is what resumes the turn; starting a new turn would break
  Codex's tool-call state.
- The official App Server test-client keeps request routing separate from
  notifications, reinforcing the adapter's independent event queue and pending
  request map.

### Other agent bridges

- MCP and ACP-style stdio integrations reinforce three useful patterns:
  bounded diagnostics, strict correlation IDs, and explicit process ownership.
- Projects that expose another model only as a subagent solve delegation, not
  primary-model replacement. This plugin therefore keeps DSH as the harness
  and treats Codex only as its model/runtime transport.

## Decisions

1. Use App Server rather than parsing Codex terminal output.
2. Keep one ephemeral Codex thread per active DSH session.
3. Make DSH dynamic tools the action plane.
4. Pause on a Codex tool request and resume it with the matching DSH result.
5. Discover models from the logged-in CLI rather than ship a stale catalog.
6. Keep protocol types minimal and hand-authored; generate official schemas in
   CI/evaluation when upgrading Codex.
