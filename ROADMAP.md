# Roadmap

**English** | [中文](./ROADMAP.zh-CN.md)

Ordered by "can a benchmark see it?". A feature whose value can't be measured doesn't get scheduled — building it would mean never knowing whether it helped.

## Where the gaps came from

Item-by-item comparison against [Pi](https://github.com/earendil-works/pi) (minimal coding agent), [DeerFlow](https://github.com/bytedance/deer-flow) (long-horizon SuperAgent harness), [Hermes](https://github.com/NousResearch) (five-layer architecture) and the Claude Code source. What follows is what's genuinely missing; the rest is either done or deliberately out of scope.

### ✅ 1. Sub-agent delegation (implemented)

`delegate(goal, max_steps?)` is a server tool. A sub-agent is **just a normal turn in its own thread**, reusing the same `runTurn` and workspace — so it inherits idempotency, crash recovery and auditability for free.

Isolation comes from the **thread boundary**: `fold` loads events per thread, so a sub-agent's intermediate messages can never surface in the parent's projection. Nothing in `fold` changed. Sub-thread IDs derive deterministically from the parent turn plus `tool_call_id`, so re-dispatching the parent doesn't re-run the sub-task.

Depth capped by `MAX_DELEGATE_DEPTH` (default 2); `delegate` isn't listed at all when `spawn` isn't injected. Tests in `test/subagent.test.ts` cover isolation, context size, depth and replay idempotency.

**Not done:** per-sub-agent tool allow-lists (DeerFlow has them). Sub-agents currently inherit the parent's tool set.

**And it hasn't been shown to be worth anything.** On `hard-04`, built specifically for it, the model chose to read all 18 files itself **6 times out of 6** and never called `delegate` — correctly, since 18 files is nowhere near context pressure. Measuring delegation needs a scenario with **dozens of sub-tasks each requiring multi-turn exploration**, where not delegating necessarily blows the budget. That's the next evaluation task to build — not more features on `delegate`.

### ✅ 2. Cross-session memory (implemented)

The one layer missing from Hermes's five (Instructions / Constraints / Feedback / **Memory** / Orchestration); DeerFlow and Claude Code have it too. All three converged on the same shape, which is a strong signal:

```
memory/
  MEMORY.md      index — one line per entry, always in the system prompt
  <slug>.md      one memory — name/description/type in frontmatter, body on demand
```

**The two levels exist for cost**: the index stays resident, bodies never occupy context until `recall` pulls them. Dumping everything into the system prompt makes the agent worse as memory grows.

Retrieval uses term overlap rather than another LLM call (Claude Code uses a small side-query model to pick top-5). The reason is evaluation: an LLM selector entangles "was the memory useful" with "was the selector accurate", and costs a call per recall. Deterministic scoring is dumber but unit-testable, free and reproducible.

**Not done:** cross-thread evaluation tasks (state a preference in round one, check recall in round two). Every bench task gets a fresh sandbox, so the harness is single-thread by construction — testing memory means extending the protocol first. Memory therefore has unit tests (`test/memory.test.ts`) but **no benchmark score**, same status as sub-agents.

### ✅ 3. Skill tool allow-lists (implemented)

A skill's frontmatter declares `allowed-tools: a, b, c` and the framework narrows the tool surface. Two layers: **not listed**, plus **re-checked before execution**. Intersection when several skills are active.

One scoping problem worth recording: the first implementation made a skill effective merely by existing, so a writing skill declaring only `web_search`/`write_document` wiped out the entire coding tool set — a unit test caught it immediately. DeerFlow's semantics are "restricted **after activation**", and this project has no activation mechanism yet (skills are always injected), so the approximation is: **if a skill's declared tools don't intersect the current tool set, it's irrelevant here and doesn't participate**. The real fix is an activation mechanism.

### 4. Bash permissions should use a classifier, not a blocklist

Found while reading the Claude Code source: its `BashTool` goes through `awaitClassifierAutoApproval` — **a classifier decides whether a command is safe**. Approval sources split into `hook` / `user` / `classifier`, rejections into `hook` / `user_abort` / `user_reject`, and sub-agents get their own rejection message.

This project uses a regex deny-list, and the comment in `bash.ts` already concedes that a blocklist "is never complete; it catches mistakes, not attacks". A classifier is the better direction: no regex will ever catch a command assembled at runtime like `rm -rf $(cat /tmp/x)`.

The cost is one extra LLM round-trip per bash call. A sensible compromise is **tiering**: an allow-list passes straight through (`ls`, `cat`, `git status`), the deny-list rejects outright, and only the grey zone asks the classifier.

**How to measure:** `constrain-01`'s Security gate already exists — add a batch of "looks harmless, actually escalates" commands. Regexes will miss them, a classifier should catch them. That task set doesn't exist yet.

### 5. The bench deadlocks under long high-concurrency runs (highest priority)

Hit twice while running HumanEval: a 240-cell run stopped mid-way, log mtime unchanged for three to four minutes.

- First in the `pi` configuration — `agent.abort()` couldn't cancel the underlying streaming request. A `Promise.race` fallback was added.
- Second in the `react-min` configuration — which **already had** `withTimeout`, and still hung 216 seconds against a 150-second timeout.

So the problem isn't any one configuration's timeout, it's lower down: concurrency 6 + Python subprocesses + streaming fetch deadlocks somewhere, and `Promise.race` can only reject the **waiting** promise — it can't cancel I/O that's genuinely stuck.

The current workaround is concurrency 3. The real fix is **process-level isolation** per cell (worker_threads or a child process) so a timeout can simply kill it. An evaluation harness can't rely on the code under test exiting gracefully — the `pi` configuration already taught us that.

## Debts owed

- **Multi-instance horizontal scaling**: in BullMQ mode SSE chunks are emitted by the executing process's bus; multiple instances need chunk relay over Redis pub/sub. The per-thread lock and the cancel abort handle are in-process too; multi-instance needs a Redis lock plus cancel pub/sub. Today gateway and worker must share one process, single instance.
- **Sandboxing is path-level by default**: `workspace.ts` blocks `../../etc/passwd`, not `cd /` inside bash. Container mode exists (`SANDBOX=docker`), but there's no per-thread container isolation yet. DeerFlow operates at container/K8s level here.
- **Incremental fold**: every round calls `load(threadId)` and replays everything. Measured not to be a bottleneck at current task sizes (per-task latency matches the minimal loop), but it will be past tens of thousands of events. Change it when it becomes measurable.
- **Chinese source comments**: docs are bilingual, the source isn't — a real barrier for international contributors. Translating ~3000 lines of comments is its own piece of work.

## What the bench itself needs

- **Model coverage**: only DeepSeek v4 so far. Harness-Bench's central finding is "stronger model, smaller harness gap"; confirming the reverse on weaker models is the most direct way to validate the framework's value.
- **`hard-03` isn't big enough**: billed as a large workspace, it's 5.5k tokens inlined and `raw` handles it easily. Locking out a tool-less baseline needs 50k+ tokens.
- **A task that actually needs delegation**: see item 1.
- **Cross-thread memory evaluation**: see item 2.
- **Third-party frameworks**: Pi's agent loop is integrated (`packages/bench/src/harness/pi.ts`). DeerFlow is a Python/LangGraph stack and would need a cross-language runner — under evaluation.
- ✅ **Cache hits are in the cost model** (2026-09-30): `Usage.cached_tokens` reads DeepSeek's `prompt_cache_hit_tokens`; the report prices hits and misses separately and adds a cache-hit column. The data immediately exposed two problems (an unstable prefix, an irrelevant skill in every prompt); after fixing both, `my-agent` cost per task dropped 13% on flash and 7% on pro — see [BENCHMARK round three](./BENCHMARK.md).
- **`my-agent` still costs 28% more than `react-min` on v4-pro**: the extra is the `delegate` / `remember` / `recall` schemas, the working rules and the workspace listing. On a saturated task set they buy no score; next is proving them on harder tasks or mounting them on demand.
- **Tool results are truncated at 4000 characters**: cheap, but lossy for big files and long logs. Better: write oversized results to a file and keep a preview plus the path in context. The current task set is too small to show a difference; it needs a context-heavy set (SWE-bench, below).
  (A pothole already stepped in: Pi's `usage.input` **excludes** cache hits while ours includes them. Before aligning the definitions we briefly concluded "Pi uses 4.4× fewer tokens", which was entirely a measurement artifact.)
