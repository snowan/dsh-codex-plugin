# Architecture

## Design goal

Make Codex the DSH primary model without replacing DSH's agent loop. The
adapter therefore implements DSH's provider-neutral `LlmAdapter` boundary and
translates it to Codex App Server v2.

## Components

| Module | Responsibility |
| --- | --- |
| `rpc-client.ts` | JSONL framing, bidirectional request routing, cancellation, process closure |
| `process.ts` | DSH-managed process spawn, initialize handshake, paginated model discovery |
| `translate.ts` | Messages, JSON Schemas, images, and tool results |
| `bridge.ts` | Per-session thread/turn state and tool-call continuation |
| `adapter.ts` | DSH `LlmAdapter` catalog, metadata, and streaming surface |
| `index.ts` | Cordis plugin configuration and provider registration |
| `doctor.ts` | Standalone login and protocol diagnostics |

## State machine

```mermaid
stateDiagram-v2
    [*] --> Starting: first DSH stream
    Starting --> Running: initialize + thread/start + turn/start
    Running --> WaitingForTool: item/tool/call
    WaitingForTool --> Running: matching DSH tool-result
    Running --> Complete: turn/completed
    Running --> Failed: non-retryable error or process exit
    WaitingForTool --> Failed: missing result or service restart
    Complete --> Running: next user turn
    Complete --> [*]: idle eviction / disposal
    Failed --> [*]
```

## Tool identity

Codex's `callId` becomes the DSH `ToolCallBlock.id`. DSH returns the same value
as `ToolResultBlock.toolCallId`. The bridge uses that identity to respond to the
original server-to-client JSON-RPC request. No tool output is placed into a new
Codex user turn.

## History and replay

While the process is live, Codex owns its thread history and DSH owns the
durable session log. The adapter returns a small JSON replay marker containing
bridge, thread, turn, and pending-call identities. If the in-memory process is
gone, the next request seeds a new Codex thread with a canonical transcript
derived from the DSH message history.

## Safety boundary

The child process is started by `ctx.subprocess`, not raw `child_process`, so
DSH owns the process tree, explicit environment, bounded stderr, cancellation,
and termination grace. Codex threads use read-only sandboxing and `never`
approval. Thread config disables Codex-native shell, apps, MCP, browser, and
related action features by default, while model instructions direct actions
through DSH dynamic tools. DSH executes those tools under its own permission
and audit services.
