# Contributing

**English** | [中文](./CONTRIBUTING.zh-CN.md)

## Getting started

```bash
npm install
npm run dev:server        # :8787  memory store + mock LLM + inline runner, zero dependencies
npm run dev:web           # :3000
```

Everything runs without an API key — the mock provider is a deterministic script. To connect a real model see the [README](./README.md#connect-a-real-model).

## Run these four before opening a PR

```bash
npx tsc --noEmit -p apps/server && npx tsc --noEmit -p packages/bench
npm test                                       # engine unit tests
npm test -w packages/bench                     # grader self-tests
npm run bench:resilience -w packages/bench     # fault-injection regression, zero API cost
```

That's exactly what CI runs, none of it needs an API key, and all four must be green.

`npm run bench:doctor -w packages/bench` reports what else your machine can run (python, docker, datasets).

## Change guidelines

**Adding a tool** — write the implementation under `apps/server/src/tools/`, register it with `defineTool()`, pick a `group` (`chat`, `coding` or `memory`). No runner changes, no protocol changes. Client tools (the ones needing a user reply) set `client: true` and reuse the existing suspend/resume wire.

Mark a tool `parallelSafe: true` only if it is genuinely read-only. Writes stay serial: a model emitting `mkdir` and a write in the same batch doesn't mean they can actually run concurrently.

**Touching the engine** — `fold` and `decide` are pure functions with no I/O, so they can be unit-tested without any mock infrastructure. Before changing them, ask: **can this behaviour be expressed as a new event type?** Events are append-only; that's the foundation everything else rests on.

**Adding a bench task** — push a `BenchTask` into `packages/bench/src/tasks/`, and add a golden solution to `GOLDEN` in `test/oracle.test.ts`. Tasks without a golden solution aren't accepted — if the oracle can't tell good from bad, every score it produces is noise.

**Touching persistence** — the Memory and Postgres implementations change together. They sit side by side in `store.ts` for exactly that reason.

**Touching the sandbox** — `Executor` covers command execution, `WorkspaceLike` covers files. Container mode implements the same interfaces through shell commands, which is why tool code needs no changes. If you add a `WorkspaceLike` method, implement it in both `Workspace` and `ContainerWorkspace`.

## A few unwritten rules

- Comments explain **why**, not what. Especially where something looks simplifiable but isn't.
- Error messages should point at the next action. `old_string matched 3 times in x.ts. Add context to make it unique.` beats `edit failed`.
- State boundaries instead of pretending they don't exist. The "this is not a sandbox" disclaimer at the top of `bash.ts` is the model to follow.
- Prefer expressing a feature as **a new event flowing through existing machinery** over adding a side path.
- If a feature can't be measured, say so. Two features here are documented as negative results — that's the standard, not an exception.

## Repository layout

```
Dura-Agent/
├─ packages/protocol/        # shared types: events, chunks, DTOs (zero deps)
├─ packages/bench/           # harness comparison bench (see BENCHMARK.md)
│  ├─ src/harness/           # raw / react-min / my-agent / pi adapters
│  ├─ src/tasks/             # 17 hand-built tasks + HumanEval + SWE-bench
│  ├─ src/{runner,score,report,doctor}.ts
│  └─ src/resilience.ts      # fault injection: crash / duplicate delivery / dangling call / context growth
├─ apps/server/              # Fastify gateway + engine
│  ├─ src/engine/            # fold / decide / runner  ← start reading here
│  ├─ src/llm/               # provider abstraction + openai-compat + mock
│  ├─ src/tools/             # registry + chat / coding / memory groups
│  ├─ src/{store,queue,bus,skills,workspace,prompt,memory,executor}.ts
│  └─ skills/                # markdown skills
├─ apps/web/                 # Next.js chat frontend (SSE + reducer + cold load)
└─ scripts/sync-from-upstream.sh
```

Start at `apps/server/src/engine/` — three files, and they are the whole system.

## Language

Docs are bilingual: English is the default, `*.zh-CN.md` sits alongside. **Commit messages and PR descriptions should be in English.**

Source comments are currently in Chinese — a known gap tracked in [ROADMAP.md](./ROADMAP.md). New code may be commented in either language; English is preferred.
