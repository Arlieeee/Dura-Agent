# Dura-Agent

**English** | [中文](./README.zh-CN.md)

[![Node.js 22+](https://img.shields.io/badge/node-22%2B-3c873a)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.6-3178c6)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

An event-sourced agent framework where **the event log is the only source of truth, state is a fold, behaviour is a pure function, and execution is a queued job**.

It ships with something most agent frameworks don't: **a benchmark harness that measures the framework itself** — same model, same tools, same endpoint, swap only the execution layer, and find out what the harness is actually worth.

Spoiler from our own numbers: **+24pt on tasks that require computing, executing or cross-checking files — and ~0 on single-function code generation.** A harness buys you *interaction with the environment*, not *writing correct code*. Details in [BENCHMARK.md](./BENCHMARK.md).

---

## Table of Contents

- [Why another agent framework](#why-another-agent-framework)
- [Quick Start](#quick-start)
- [Core Design](#core-design)
- [Core Features](#core-features)
- [Benchmarking](#benchmarking)
- [Deployment](#deployment)
- [Security Notice](#security-notice)
- [How it compares](#how-it-compares)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Why another agent framework

Agent frameworks are usually judged by the score of `model + harness` as a package, and that score gets filed under the model's name. [Harness-Bench](https://arxiv.org/abs/2605.27922) quantified the problem: swapping only the execution layer moved results by up to **23.8 points**.

Dura-Agent inverts this: **the framework is the thing under test.**

Two consequences shape the entire codebase:

1. **Everything is a pure function over an append-only log.** `fold(events) → state` and `decide(state) → command` perform no I/O, so they are unit-testable and replayable. Recovery isn't a special path — it *is* the normal path.
2. **A feature has to be measurable.** If a capability can't be shown to move a benchmark number, it doesn't get scheduled. Two features in this repo are documented as **negative results** for exactly that reason — see [ROADMAP.md](./ROADMAP.md).

## Quick Start

Zero dependencies, about 30 seconds. No API key required — the mock provider is a deterministic script that exercises the full pipeline.

```bash
npm install
npm run dev:server        # :8787  memory store + mock LLM + inline runner
npm run dev:web           # :3000
```

Open <http://localhost:3000> and send *"search for event sourcing and write it up for me"*. You'll go through the whole loop: `web_search → ask_user (suspend) → write_document → summary`.

**Refresh the page mid-run.** The cold load rebuilds identical content from the event log — one truth, projected two ways.

### Connect a real model

Everything speaks the OpenAI-compatible protocol, so switching models is an env change:

```bash
PROVIDER=openai-compat
PROVIDER_BASE_URL=https://api.deepseek.com   # or OpenAI / GLM / Qwen / any gateway
PROVIDER_API_KEY=sk-xxx
PROVIDER_MODEL=deepseek-v4-pro
```

For Anthropic's native protocol, write one more adapter against the interface in `llm/openai-compat.ts` — `ChatProvider` is the only contract.

### Persist to Postgres

In memory mode a server restart (including a `tsx watch` reload) wipes the log.

```bash
docker compose up -d      # local pg + redis
# add to .env.local:
# DATABASE_URL=postgres://myagent:myagent@localhost:5432/myagent
npm run dev:server
```

Four tables are created on first connect: `agent_events` (the single source of truth), `threads`, `turns`, `artifacts`.

### Production mode (Redis queue)

```bash
RUNNER_MODE=bullmq REDIS_URL=redis://localhost:6379 npm run dev:server
```

**Crash drill:** `kill -9` the server mid-generation, then restart. The sweeper notices the missing heartbeat, the job is re-dispatched, `fold` replays the log, deterministic IDs make the already-done steps no-ops, and the turn converges. That's convergent re-execution.

## Core Design

| Concept | Implementation | File |
|---|---|---|
| Event log = single source of truth | `agent_events` table / `MemoryStore` | `apps/server/src/store.ts` |
| `fold(events) → state` | pure function, no I/O | `engine/fold.ts` |
| `decide(state) → command` | pure function, no I/O | `engine/decide.ts` |
| Runner + queue | `runTurn()`, inline / BullMQ | `engine/runner.ts`, `queue.ts` |
| Deterministic event IDs | sha1 content hash — writing twice equals writing once | `store.ts` |
| Heartbeat + sweeper + re-dispatch | `heartbeat_at` + timer | `queue.ts` |
| Live projection over SSE | bus + streaming `/turns` | `bus.ts`, `index.ts` |
| Suspend / resume | `turn.suspended` event + `/continue` | `runner.ts`, `fold.ts` |
| Cancel | durable `user.interrupt` event + `AbortSignal` on the stream + `/cancel`; cascades to sub-agents | `runner.ts` (cancelTurn), `decide.ts` |
| One turn per thread | admission gate (unfinished turn → 409) + in-process thread lock in the runner | `index.ts`, `runner.ts` (withThreadLock) |
| Context compaction | `compaction.summary` anchor event; the summary request replays the conversation's exact prefix and only appends an instruction | `runner.ts` |
| Tool-output spill | Results over the inline budget go to `.dura/spill/` in full; the context keeps head + tail + a pointer (previously a silent cut) | `engine/tool-output.ts`, `runner.ts` |
| Append-only requests | Static system prompt; workspace listing / memory are a `context.snapshot` event rendered as a user message — every request extends the previous one (pinned by a test) | `prompt.ts`, `fold.ts` |
| Pluggable tools | registry with `chat` / `coding` / `memory` groups | `tools/index.ts` |
| Task isolation | per-thread workspace + path-escape guard | `workspace.ts` |
| Real sandboxing | `Executor` (local / docker) + `ContainerWorkspace` | `executor.ts` |
| Sub-agent delegation | `delegate` — a sub-agent is just a turn in its own thread | `tools/delegate.ts` |
| Cross-session memory | index in the prompt, bodies on demand | `memory.ts` |

## Core Features

### Convergent re-execution

A turn that dies halfway is re-dispatched and picks up where it stopped. Steps already in the log become no-ops through deterministic IDs — no duplicate side effects, no duplicate billing.

The distinction that makes it work: **transient failures (network, rate limit, 5xx) never write `turn.finished`.** They append a `turn.error` counter instead. Writing `turn.finished` would make `fold` report the turn complete, and every subsequent re-dispatch would be a no-op — the turn would be permanently dead. That bug was real; the resilience suite now guards against it.

### Pluggable tools

A tool is a spec (what the model sees) plus an impl (what the runner executes), registered in one `defineTool()` call. Groups let one engine wear different faces:

- **`chat`** — `web_search`, `write_document`, `ask_user`
- **`coding`** — `read_file`, `write_file`, `edit_file`, `list_files`, `grep_files`, `bash`, `delegate`
- **`memory`** — `remember`, `recall`

`edit_file` uses exact `old_string` replacement rather than diffs, and refuses ambiguous matches. Models copy a snippet far more reliably than they generate a diff, and silently editing the wrong occurrence is worse than an error.

Read-only tools in one batch run concurrently; writes stay serial. A model emitting `mkdir` and a write together doesn't mean they can actually run at the same time.

### Sub-agent delegation

`delegate(goal)` runs a sub-agent whose intermediate messages never enter the parent's context. Isolation comes from the **thread boundary** — `fold` loads events per thread, so nothing inside `fold` needed changing. A sub-agent is a normal turn in its own thread, inheriting idempotency, crash recovery and auditability for free.

> **Honest note:** in our benchmark the model chose *not* to delegate 6 times out of 6 — 18 files is nowhere near context pressure, and its judgement was right. The feature works end to end; it has not been shown to be worth using. See [ROADMAP.md](./ROADMAP.md).

### Cross-session memory

```
memory/
  MEMORY.md      index — one line per entry, always in the system prompt
  <slug>.md      one memory — name/description/type in frontmatter, body on demand
```

Two levels because of **cost**: the index is small enough to stay resident; bodies never occupy context until needed. Dumping everything into the system prompt makes the agent *worse* as memory grows.

> **Honest note:** `deepseek-v4-pro` honours a remembered convention across sessions; `deepseek-v4-flash` gets the identical prompt and ignores it. Weaker models depend on the harness more — and follow it less.

### Skills with tool allow-lists

A skill is markdown injected into the system prompt. Its frontmatter can narrow the tool surface:

```markdown
---
allowed-tools: web_search, write_document, ask_user
---
```

Enforced in two layers: the tool isn't listed, **and** it's re-checked before execution. The second layer isn't redundant — relying on "not listed" alone bets on the model never hallucinating a tool name.

### Real sandboxing

| | `local` (default) | `docker` |
|---|---|---|
| Isolation | path-level | container-level |
| Network | host | `--network none` by default |
| Files | host fs | volume mount, or an image's own directory |

`ContainerWorkspace` translates each `WorkspaceLike` method into a shell command, so **the file tools work unchanged inside a container** — including `edit_file`'s uniqueness checks. That's what makes SWE-bench-style evaluation possible, where code lives at `/testbed` inside an image the host can't see.

## Benchmarking

The framework ships with its own evaluation harness. Methodology follows Harness-Bench: fix the task prompt, initial sandbox, budget, timeout and grader — vary **only** the execution layer.

Four configurations sharing one provider implementation, one tool implementation, one endpoint:

| harness | What it is |
|---|---|
| `raw` | One API call. No tools, no loop, no state. **The "no harness" baseline** |
| `react-min` | The 20-line while loop from every tutorial |
| `my-agent` | The full harness in this repo |
| `pi` | [Pi](https://github.com/earendil-works/pi)'s agent loop — a real third-party framework |

```bash
npm run bench:doctor -w packages/bench        # what can this machine run?
npm run bench:resilience -w packages/bench    # fault injection, zero API cost
npm run bench -w packages/bench -- --repeat 5 # full comparison (needs an API key)
npm run bench:session -w packages/bench       # 9-turn session through compaction, meters every call's cache hits
```

Grading is `TaskScore = Security × Completion × Process`. Security is a multiplicative gate — one privilege violation zeroes the task. **No LLM judges**: we're comparing models, so the grader can't be one. The graders themselves are tested (41 assertions: golden solutions must score 1.0, doing nothing must score below 1.0, editing the test file to force a pass must score 0).

Full methodology, results and limitations: **[BENCHMARK.md](./BENCHMARK.md)**.

## Deployment

```bash
# .env.local must set AUTH_SECRET (openssl rand -hex 32) and PROVIDER_*; set CORS_ORIGIN too
docker compose --profile prod up -d --build
curl http://localhost:8787/healthz
```

| Item | Env | Notes |
|---|---|---|
| Signing key | `AUTH_SECRET` | **Required**; production refuses to start without it |
| CORS | `CORS_ORIGIN` | Comma-separated; unset = wide open (dev only) |
| Token TTL | `TOKEN_TTL_HOURS` | Default 168 (7 days) |
| Rate limits | `RATE_LOGIN_PER_MIN` / `RATE_TURNS_PER_MIN` | Default 30 / 10, 0 disables |
| Health check | `GET /healthz` | Container / load-balancer probe |

**Topology constraints** (real distributed-systems problems, stated rather than hidden):

1. One Postgres runs **one** runner mode. Inline mode is single-instance only.
2. In BullMQ mode SSE chunks are emitted by the executing process's bus. **Horizontal scaling needs chunk relay over Redis pub/sub** — not implemented, so run one instance with gateway and worker in the same process.

## Security Notice

Read this before enabling `bash`.

- **`local` mode is not a sandbox.** `workspace.ts` blocks `../../etc/passwd`; it does not block `cd /` inside bash. Enabling `bash` in local mode hands the host to the model.
- The command deny-list catches **mistakes, not attacks**. Blocklists are never complete — a command assembled at runtime like `rm -rf $(cat /tmp/x)` walks straight past a regex. Claude Code uses a classifier here; we don't yet ([ROADMAP](./ROADMAP.md)).
- For anything untrusted use `SANDBOX=docker`. Containers default to `--network none`.
- `bash` is **off by default** (`ENABLE_BASH=1` to enable).

## How it compares

| Framework | Its approach | Ours |
|---|---|---|
| **[Pi](https://github.com/earendil-works/pi)** | Minimalism: 4 core tools, sub-1000-token system prompt, append-only JSONL session tree | Tool surface and prompt discipline **borrowed directly**. The difference is persistence: their JSONL tree excels at branching, our event log at crash recovery and idempotency |
| **[DeerFlow](https://github.com/bytedance/deer-flow)** | SuperAgent harness: LangGraph checkpointer, container/K8s sandbox, sub-agents, memory, IM gateways | Same durability idea by a different mechanism. Its sub-agent and memory designs are the gaps we closed |
| **[Hermes](https://github.com/NousResearch)** | Five layers: Instructions / Constraints / Feedback / **Memory** / Orchestration; SKILL.md written by the agent itself | Memory was the one layer we lacked. Our shape converged on the same two-level structure |
| **Claude Code** | Permission checks on every tool call (hook / user / **classifier**); `memdir` picks top-5 memories via a small side-query model | Memory structure learned directly from it. Its classifier-based bash safety beats our regex deny-list — on the roadmap |
| **LangChain / LangGraph** | Graph orchestration with explicit nodes and edges | No graph. Orchestration is one pure function, `decide(state) → command` — unit-testable and replayable. Complex topologies are on you |
| **Temporal** | General-purpose durable execution | Same idea, narrower scope: agent semantics only, one less piece of infrastructure |

> A cross-check worth noting: DeerFlow's docs mention *injecting placeholder tool results for dangling calls*, while we **strip** those orphans in `fold` (the never-started kind; see below for the started kind). Two independent frameworks cornered by the same problem — a crash-orphaned `tool_call` with no result will 400 the next API request and poison the whole session. Different fixes, same unavoidable pothole. We froze it into [resilience scenario R3](./BENCHMARK.md).
>
> The nastier case is a call that **started but has no result**: the side effect happened, the result was never persisted. The runner appends `tool.started` before executing; on redelivery only tools declared replay-safe (read-only, whole-file writes, deterministic sub-tasks) re-run, and the rest get an `interrupted` result so the model verifies state first — resilience scenario R5.

## Documentation

| Doc | Contents |
|---|---|
| [BENCHMARK.md](./BENCHMARK.md) | Methodology, four configurations, results, and everything that didn't work |
| [ROADMAP.md](./ROADMAP.md) | Gaps ranked by "can a benchmark see it?", plus debts owed |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Local setup, the four pre-PR checks, change guidelines |
| [TESTING.md](./TESTING.md) | End-to-end test records |

Start reading at `apps/server/src/engine/` — three files, and they are the whole system.

## Contributing

```bash
npx tsc --noEmit -p apps/server && npx tsc --noEmit -p packages/bench
npm test                                       # engine unit tests
npm test -w packages/bench                     # grader self-tests
npm run bench:resilience -w packages/bench     # fault-injection regression, zero API cost
```

Those four are exactly what CI runs, and none of them need an API key. Details in [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
