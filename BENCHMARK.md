# Bench — measuring the harness on its own

**English** | [中文](./BENCHMARK.zh-CN.md)

One sentence: **same model, same tools, same endpoint — swap only the execution layer and see how much the score moves.**

## Why measure the harness separately

Mainstream agent leaderboards (SWE-bench, Terminal-Bench, τ-bench) evaluate `model + harness` as a package, and the number gets filed under the model's name. [Harness-Bench](https://arxiv.org/abs/2605.27922) quantified the problem: six configurable harnesses spread the same models across **23.8 percentage points**, and the weaker the model, the more the harness matters.

This bench follows the same experimental design:

| | Fixed | Varied |
|---|---|---|
| Task prompt | ✅ verbatim identical | |
| Initial sandbox | ✅ re-laid from the same setup for every cell | |
| Budget / timeout | ✅ same `maxSteps`, same timeout | |
| Grader | ✅ one deterministic oracle | |
| Provider implementation & endpoint | ✅ one `OpenAICompatProvider` | |
| Tool implementation | ✅ one `tools/` directory | |
| **Execution layer (harness)** | | ✅ four |
| **Model** | | ✅ selectable |

That's what makes a score difference attributable to the execution layer rather than to prompt wording or luck.

## The four configurations

| harness | Has | Deliberately lacks |
|---|---|---|
| `raw` | One chat call. Workspace contents inlined into the prompt, files returned as JSON and written back by the bench | No tools, no loop, no state. **The "no harness" baseline** |
| `react-min` | Same tools + a while loop. The 20-line agent from every tutorial | No prompt engineering, no context management, no error recovery, no persistence |
| `my-agent` | Event sourcing, `fold`/`decide`, projection cleanup, transient-failure re-dispatch, per-scenario prompts, workspace listing injection, compaction | — |
| `pi` | **A real third-party framework**: [Pi](https://github.com/earendil-works/pi)'s `Agent` loop — event-driven, parallel tool execution, context hooks, JSONL session tree | — |

Why does `raw` get the workspace inlined? Because it has no `read_file`. Withholding it would test *"can it read files"* rather than *"does a harness help"*. Given full information, wherever it loses is unambiguous.

**Control-variable trade-offs for `pi`** (read before the scores): the first three configurations are all this repo's code — same origin, likely the same blind spots. An external implementation is how you find out whether a gap is real. Two things were swapped to keep the comparison clean:

- **Tools**: this repo's implementations wrapped as Pi `AgentTool`s, not Pi's own read/write/edit/bash. The semantics already match — this repo's tool surface was designed from Pi's conclusions.
- **Prompt**: the same coding prompt as `my-agent`, not Pi's CLI prompt.

So this measures **Pi's agent loop**, not "Pi CLI out of the box". The latter might score higher, but three variables would have changed at once and nothing would be attributable. Pi is an optional dependency — the configuration is skipped if absent.

## Two task sets

**17 hand-built tasks** — offline, deterministic, one oracle each, across 7 capability dimensions:

| Dimension | Tasks | What it probes |
|---|---:|---|
| software-engineering | 6 | Precise edits, bug fixes verified by tests, filling a stub until tests go green |
| data-analysis | 2 | CSV aggregation, structured transforms with filter + sort |
| multi-file-refactor | 1 | Rename across 4 files — miss one and you lose points |
| retrieval | 3 | Cross-file counting, log aggregation, 30-module workspace search |
| error-recovery | 2 | A wrong path in the prompt; an `edit` that fails on ambiguity |
| long-horizon | 2 | Five dependent steps; an answer that requires executing 5000 iterations |
| constraint-following | 2 | A file that must not be touched; an output format pinned exactly |

**HumanEval** (OpenAI, 164 Python tasks) — a real public benchmark, brought in not to chase a leaderboard but because it puts our central question in plain sight:

> **The official pass@1 protocol is "generate once, no iteration"** — exactly the `raw` configuration. A harness-equipped agent can write a file, run the tests, read the error and fix it.

Same tasks, same model, two modes of play. And unlike hand-built tasks, that number can be calibrated against published pass@1 figures.

```bash
node scripts/fetch-datasets.mjs humaneval          # data isn't in version control
npm run bench -w packages/bench -- --tasks humaneval:60
```

**No LLM judges.** We're comparing models, so the grader can't be one. Every oracle reads final workspace state or runs a test script and checks the exit code.

**The graders are themselves tested** (`npm test -w packages/bench`, 41 assertions): every task has a golden solution that must score 1.0; doing nothing must score below 1.0; editing the test file to force a pass must score 0. If the oracle can't tell good from bad, every number downstream is noise.

## Scoring

Multiplicative structure, as in Harness-Bench:

```
TaskScore = Security × Completion × Process
```

- **Security** (0/1 gate): a privilege violation zeroes the whole task. Example: `constrain-01` forbids reading or writing `secrets.env`; touching it is a zero no matter how well the task was done.
- **Completion** (0..1): the oracle's objective verdict. **The primary metric** — "did it work?"
- **Process** (0.4..1): mean of robustness (error recovery), efficiency (budget usage) and coherence (final-state consistency). A quality discount, not a second pass/fail bar — hence the 0.4 floor, so process never drowns out completion.

One Process component specifically catches the most dangerous agent failure mode: **claiming success while the oracle says otherwise** drops coherence to 0.

## Results

### Hand-built tasks — 4 configurations × 2 models × 3 samples = 408 cells

`maxSteps=15`, `timeout=240s`, thinking disabled, total API cost ≈ **$0.77**.

| Model | harness | Completion | TaskScore | LLM calls/task | Total tokens | Cost/task |
|---|---|---:|---:|---:|---:|---:|
| v4-flash | `react-min` | **98.8%** | 97.0% | 5.41 | 425,913 | $0.0013 |
| v4-flash | `my-agent` | **97.4%** | 96.3% | 4.73 | 414,341 | $0.0012 |
| v4-flash | `pi` | **96.2%** | 95.1% | 4.63 | 393,227 | $0.0011 |
| v4-flash | `raw` (native API) | **74.8%** | 74.8% | 1.00 | 36,921 | $0.0001 |
| v4-pro | `pi` | **100.0%** | 98.8% | 4.55 | 401,312 | $0.0036 |
| v4-pro | `react-min` | **100.0%** | 98.5% | 5.20 | 412,439 | $0.0038 |
| v4-pro | `my-agent` | **95.7%** | 94.6% | 4.47 | 407,591 | $0.0037 |
| v4-pro | `raw` (native API) | **84.2%** | 84.2% | 1.00 | 38,626 | $0.0004 |

### HumanEval — 60 tasks, v4-flash

| harness | pass@1 | Sample |
|---|---:|---:|
| `react-min` | 97.9% | 47 |
| `my-agent` | 97.4% | 39 |
| `raw` (generate once) | **96.7%** | 60 |

(Uneven samples: the run deadlocked partway — see [ROADMAP](./ROADMAP.md) item 5.)

### Five conclusions

**1. A harness is worth +16 to +24 points over the native API — and the stronger the model, the less it's worth.**

| | `raw` | Best harness | Delta |
|---|---:|---:|---:|
| v4-flash | 74.8% | 98.8% | **+24.0pt** |
| v4-pro | 84.2% | 100.0% | **+15.8pt** |

A stronger model cut the harness's marginal value by a third. This **independently reproduces Harness-Bench's core claim**: execution-layer differences get absorbed by model capability. Practical corollary — on a frontier model doing simple work a naive loop may be enough; the weaker the model and the longer the task, the more the harness pays.

**2. The value is not evenly spread — it concentrates in a few task types** (v4-flash):

| Dimension | `raw` | With harness | Gap |
|---|---:|---:|---|
| data-analysis | 20.0% | 83–100% | **-80pt** can't compute |
| long-horizon | 50.0% | ~97% | **-47pt** can't execute |
| retrieval | 74.1% | 85–100% | **-26pt** can't count reliably |
| software-engineering | 98.0% | 100% | -2pt |
| multi-file-refactor | 100% | 100% | **0** |

`raw` loses in consistent places, the same way every sample — a capability boundary, not variance:

- `data-01` (sum a 40-row CSV): wrong every time, yet `top_region` right every time. **It can see; it can't compute.**
- `data-02` (filter + sort): includes the `active:false` record every time. A filter condition buried in a long prompt gets ignored.
- `hard-01` (answer requires 5000 iterations of execution): **0%**. No execution means no answer, however smart the model.
- `retrieval-01` (count across 8 files): everything is in context; the count is still wrong.

Conversely, on pure text-rewriting tasks (`edit-*`, `refactor-01`, `bug-*`) `raw` scores full marks. **When the workspace fits in the prompt and the answer needs neither computation nor execution, a harness creates no value.** Worth thinking through against your own use case.

**3. HumanEval: a harness is nearly worthless there — consistent, not contradictory.**

Three configurations within 1.2pt, while the same harnesses gain +24pt on the hand-built set. Both facts say the same thing:

> **A harness's value depends on task shape, not task difficulty.**

HumanEval is "one function, no dependencies, full spec in the prompt, correct on the first try" — precisely `raw`'s best case, the same category as the `edit-*` / `bug-*` tasks where `raw` also scored full marks. What separated the configurations elsewhere was `data-*` (compute), `hard-01` (execute), `retrieval-*` (cross-check).

**A harness buys interaction with the environment, not correct code.**

This is also why *harder single-function benchmarks won't help*: LiveCodeBench would just lower all four configurations together. Opening a gap requires changing the **shape** — see the SWE-bench section.

**4. The gains aren't free: roughly 11× the tokens.**

| harness | Tokens/task | v4-flash Completion | Token cost per point gained |
|---|---:|---:|---|
| `raw` | 724 | 74.8% | — |
| `pi` | 7,710 | 96.2% | ~326 |
| `my-agent` | 8,125 | 97.4% | ~328 |
| `react-min` | 8,351 | 98.8% | ~318 |

All three harnesses are equally token-efficient. Repeatedly resending context is intrinsic to an agent loop, not one framework's implementation flaw.

> Costs are an **upper bound**: DeepSeek's cache-read price is 50× cheaper, but this repo's provider only records total `prompt_tokens`. See [ROADMAP](./ROADMAP.md).

**5. The four configurations are statistically tied in fair weather — including the real third-party framework.**

96.2–98.8% on v4-flash, 95.7–100% on v4-pro. Sampling noise at n=3 is that large: re-running one configuration moved `pi` from 100% to 96.2%.

Honestly: `my-agent` sits at the lower end of the three harnesses on both models (97.4% / 95.7%). Its five lost points are spread across five different tasks and different sample rounds, all "finished normally but got it wrong" — no crashes, no timeouts, no budget exhaustion, no systematic pattern. Not enough evidence to claim a difference, **and not enough to dress it up as a tie either**.

Selling a framework on "my harness scores higher" does not hold up at this task scale.

### Ablation: what execution capability is worth

Same harness, same model, same 8 tasks × 3 samples — only `bash` turned off:

| harness | With bash | Without | Delta |
|---|---:|---:|---:|
| `react-min` | 98.7% | 85.0% | **-13.7pt** |
| `my-agent` | 99.0% | 80.0% | **-19.0pt** |

Per task, the loss isn't spread evenly — it lands on two:

| Task | `react-min` | `my-agent` |
|---|---|---|
| `hard-01` (answer needs 5000 iterations) | 100% → **0%** | 100% → **0%** |
| `long-01` (five dependent steps) | 96% → 80% | 92% → 80% |
| Remaining 6 | unchanged | unchanged |

**Execution capability is binary.** `hard-01` doesn't get "a bit harder" without bash — it goes to zero, exactly matching `raw`'s 0% on the same task. An agent that cannot execute will never reach an answer that only a program can produce, no matter how many turns or how much context.

## Deriving improvements from failure traces

The value of a benchmark isn't the ranking — it's that **it puts the failure reasons in front of you.** After reading every one of `my-agent`'s lost cells, none of the three causes were what we'd have guessed:

| Task | Actual cause | Whose fault |
|---|---|---|
| `long-01` | The model wrote `read_file`'s **line numbers into the file** (`1\tALPHA` instead of `ALPHA`) | Tool design |
| `recover-01` | Found the right file, then stopped to ask "please confirm this is the one?" — but the coding tool set has no `ask_user` | Prompt |
| `data-02` | Included the `active:false` record. `raw` makes the same mistake | The model itself |

The first two were ours, and got fixed:

- `read_file` now states in every response that line numbers are display-only, and offers `raw=true`
- The coding prompt gained one rule: **don't stop and wait when no asking tool exists** — take the most reasonable reading, finish, state the assumption at the end

Re-running those five previously-failing tasks (2 models × 3 samples = 30 cells): **100% across the board.**

| Task | Before (flash / pro) | After |
|---|---|---|
| `long-01-five-steps` | 92% / 96% | **100% / 100%** |
| `recover-01-wrong-path` | 100% / 83% | **100% / 100%** |
| `data-02-json-transform` | 83% / 100% | **100% / 100%** |
| `retrieval-01-count-across-files` | 96% / 89% | **100% / 100%** |
| `hard-04-three-subsystems` (new) | — | **100% / 100%** |

> Also fixed a **trace bug that nearly caused a misdiagnosis**: the adapter claimed each `tool.result` by "finding the last tool step without a result". With multiple calls per round the event order is `call A → call B → result A → result B`, so A's result got recorded against B. The engine matches by `tool_call_id` and was always correct — only the trace reconstruction was wrong. But it very nearly produced a written conclusion that "tool calls and results are mismatched".

## When the bench manufactures a false conclusion

Worth its own section, because it almost became a beautiful and completely wrong number in this document.

First HumanEval run: `raw` 56.7%, harnesses 98–100%, **+43pt**. Larger than the +24pt on hand-built tasks — apparently strong evidence that "real benchmarks show the harness's value better".

But 56.7% doesn't square with DeepSeek's published HumanEval pass@1 (80%+). Reading the failure traces: **10 of 20 failures were "nothing written to disk"** — `solution.py` was still the untouched stub.

The cause was in the bench itself. The `raw` protocol requires wrapping files in `{"files": {...}}` JSON, while on a single-file task the model naturally just emits a code block. No JSON parsed → nothing written → all tests fail. **Those weren't capability points lost, they were protocol points lost.**

The fix: on single-file tasks, fall back to "take the last code block in the answer" when JSON parsing finds nothing. Re-running the same 20 tasks: `raw` **50% → 100%**.

Two lessons, neither about the model:

1. **Any protocol unique to one configuration is a source of bias for it.** `raw` has no tools, so it needs an invented convention for "how do I hand files back" — and that convention was costing it points. Controlling for task, budget and grader is easy to remember; controlling for protocol burden is easy to miss.
2. **When a score disagrees with an external reference, suspect your own framework first.** That +43pt fit the expected narrative perfectly. Without checking published pass@1, it would have gone straight into this document.

## Memory: the plumbing works, the weak model doesn't listen

Cross-session memory has no benchmark score — every bench task starts in a fresh sandbox, so it's single-thread by construction. Verified end-to-end against real models instead:

| | Session A (told a convention) | Session B (fresh thread, only "write hello.py") |
|---|---|---|
| `v4-pro` | Called `remember` unprompted ✓ | Wrote **2-space** indentation ✅ |
| `v4-flash` | Called `remember` unprompted ✓ | Wrote 4-space indentation ❌ |

The chain works (write → index → inject → take effect), and `v4-pro` behaves as intended. `v4-flash` receives the identical prompt (injection verified character by character) and **simply doesn't comply** — PEP 8's four-space prior is too strong for a weak model to override.

This echoes Harness-Bench in the opposite direction: **weaker models depend on the harness more, and follow it less.** A harness can put information in front of a model; it can't put it into the model's decision.

> The debugging is worth recording too: the end-to-end check failed twice, and both times we went off to change the retrieval strategy — both rounds spent on a wrong premise. The actual cause was that `buildSystemPrompt` destructured `memoryHint` but **never put it in the returned array**, and TypeScript doesn't complain about a destructured-but-unused variable. Printing the system prompt once would have found it in five minutes. **Verify the artifact before tuning the strategy.**

## Next: SWE-bench Lite (data ready, waiting on docker)

The HumanEval result says harder single-function tasks won't help. Separating the configurations requires changing **shape**, not difficulty.

SWE-bench Lite changes exactly that: a real repository plus an issue description, requiring you to locate the problem among thousands of files, change code, and verify with tests. Multi-turn and environment interaction are mandatory.

Status:

- ✅ Data layer: 300 tasks fetched (`node scripts/fetch-datasets.mjs swebench`)
- ✅ Grading per the official definition: `FAIL_TO_PASS` all passing **and** `PASS_TO_PASS` none broken → resolved. Before running tests, test files are `git checkout`'d back to their official state and `test_patch` re-applied — otherwise deleting an inconvenient assertion would "pass" the task
- ✅ Sandbox: `Executor` + `ContainerWorkspace` ready
- ⏳ The official images are x86_64, one large image per instance — run them in a cloud x86 container rather than under emulation on an arm64 laptop. `npm run bench:doctor` says exactly what's missing

```bash
npm run bench:doctor -w packages/bench
npm run bench -w packages/bench -- --tasks swebench:5 --harness raw,my-agent
```

## Sandbox: from path-level to real isolation

`bash.ts` has always carried a disclaimer at the top: path-level isolation **is not a sandbox** — it blocks `../../etc/passwd`, not `cd /` inside bash. That promise is now kept, which also unlocks SWE-bench.

`ContainerWorkspace` translates each `WorkspaceLike` method into a shell command, so `read_file` / `edit_file` / `grep_files` work inside a container **without a single line changed** — including `edit_file`'s exact-replacement and uniqueness logic.

Three potholes, all of the "no error, wrong result" variety, all now documented in comments:

1. **Passing bulk data on the command line**: base64 chunks concatenated into arguments started **silently** dropping data past ~12,000 characters — no error, `exit_code` still 0. Moved to stdin (`docker exec` gained `-i`).
2. **Output truncation**: `run()`'s 16 KB cap is a **model-facing** measure (save tokens, avoid flooding), but it was also applied to internal file reads, quietly truncating files over 12 KB. Added a `maxOutput` parameter to separate the two uses.
3. **Paths**: `ContainerWorkspace` only accepts POSIX absolute paths. A Windows path makes the drive letter look like a directory segment and trips a false "out of bounds". Now rejected at construction rather than surfacing later wearing a different mask.

## Round three (2026-09-30): cache hits, prompt size, crash mid-tool

> **The model changed, so these numbers don't compare directly with earlier rounds.** `deepseek-v4-flash` is retired and its name
> is served by V4.1-Flash. This round uses `deepseek-flash` and `deepseek-v4-pro`, priced at official off-peak rates (peak doubles
> all three, so ratios between harnesses hold). The report gains a **cache-hit** column: cached prompt tokens are priced at the
> cache-read rate (50× cheaper), so earlier costs were only upper bounds.

18 tasks × 4 harnesses × 2 models × 3 samples = 432 cells · maxSteps=12 · timeout=180s · thinking off · about **$0.40** total

| Model | harness | Completion | Cache hit | LLM calls/task | Prompt tokens/task | Cost/task |
|---|---|---:|---:|---:|---:|---:|
| flash | `react-min` | **100.0%** | 83.9% | 5.31 | 8,772 | $0.00059 |
| flash | `pi` | **98.9%** | 80.8% | 4.67 | 8,817 | $0.00060 |
| flash | `my-agent` | **98.5%** | 82.5% | 4.69 | 10,534 | $0.00061 |
| flash | `raw` | **92.6%** | 70.5% | 1.00 | 625 | $0.00023 |
| v4-pro | `my-agent` | **100.0%** | 80.7% | 3.89 | 8,301 | $0.00201 |
| v4-pro | `pi` | **100.0%** | 90.6% | 4.07 | 7,437 | $0.00150 |
| v4-pro | `react-min` | **100.0%** | 87.8% | 4.39 | 6,569 | $0.00157 |
| v4-pro | `raw` | **79.1%** | 91.2% | 1.00 | 624 | $0.00023 |

### Two changes, measured

The cache-hit data pointed at the problems; each fix is one change. Before and after ran **simultaneously** in two separate worktrees
(same time window, same model), with only `my-agent`'s code differing:

| `my-agent` | Before | ① stable prefix | ①+② scenario-scoped skills |
|---|---:|---:|---:|
| flash: cache hit from step 1 on | 85.5% | 87.8% | 87.7% |
| flash: prompt tokens/task | 11,621 | 11,040 | 10,534 |
| flash: cost/task | $0.00070 | $0.00063 | **$0.00061 (−13%)** |
| v4-pro: cache hit from step 1 on | 85.9% | 88.4% | 87.4% |
| v4-pro: prompt tokens/task | 8,732 | 8,754 | 8,301 |
| v4-pro: cost/task | $0.00216 | $0.00219 | **$0.00201 (−7%)** |
| Completion (flash / pro) | 100% / 100% | 100% / 98.1% | 98.5% / 100% |

- **① Stable prefix.** The workspace listing and memory hint were injected only at step 0, so the system prompt changed from step 1
  on: the server-side prefix cache missed, and the model stopped seeing the listing. The system prompt is now built once per runner.
  Cache hits from step 1 on: **+2.3 / +2.5pt**. Smaller than expected, because DeepSeek matches common prefixes and the base prompt
  kept hitting; only the part after the listing was lost.
- **② Scenario-scoped skills.** Every coding call carried a writing skill that uses only `web_search` / `write_document`, neither of
  which exists in coding mode. Tool narrowing already skipped such irrelevant skills; prompt injection didn't. With one shared
  predicate, the coding system prompt drops from 648 to 407 characters.
- **Completion didn't move**: 98.5–100%, within noise. Both flash misses are `constrain-02` ordering `nail` / `nut` the wrong way;
  `raw` and `pi` each did the same once in this run. The model states "same quantity, alphabetical" and then writes it backwards.
- **③ Crash mid-tool** (zero API cost, see R5 below): `tool.started` is appended before executing; on redelivery only tools declared
  replay-safe re-run, and the rest get an `interrupted` result for the model to verify. With that crash injected, an append happens
  once instead of twice; resilience goes from 4/4 to **5/5**.

**The honest part:** on v4-pro `my-agent` still costs **28%** more than `react-min` (26% more prompt tokens per task). The extra is
what `react-min` doesn't have: the `delegate` / `remember` / `recall` schemas, the working rules, the workspace listing. On this
saturated task set they buy no score. Either prove them on harder tasks or mount them on demand; it's on the [ROADMAP](./ROADMAP.md).

> **Round-four correction:** this 28% was measured unsalted, and `react-min` rode leftover cache from earlier runs; salted, the three harnesses are level on pro. See round four.

> Another **false conclusion manufactured by the bench itself**: on the first pass, `pi` scored 6.9% on flash. Not Pi's fault:
> pi-ai's model table doesn't know the renamed `deepseek-flash`, so every cell threw before its first call. Fixed, it scores 98.9%.
> A harness making zero LLM calls looks exactly like a weak harness in the report.

## Round four (2026-09-30): append-only requests, the cache discipline of DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) reports 97–99% cache hits on long sessions. The
mechanism is a rule in its engineering standard rather than a trick: every package that touches model context documents its
"KV Cache effect", i.e. whether it is append-only, prefix-stable, replacing, or an independent request. Auditing this project
against that rule started with probing where DeepSeek's cache boundaries actually are:

| Probe (two requests, the second changes one thing) | Cached on the second |
|---|---:|
| Workspace listing at the end of the system prompt; change only the listing | **0** |
| System unchanged; listing in the user message after it | 1,280 |
| Summary request: replay + append an instruction, with `tool_choice: 'none'` | **0** (tool schemas stop being rendered, the prefix changes) |
| Same, without `tool_choice` | 1,280 |

**DeepSeek caches at message boundaries, not arbitrary token prefixes**: change one character of the system message and the whole
system prompt plus the tool schemas after it miss. This project kept the workspace listing, memory and compaction summary in the
system prompt, so every new task and every post-compaction turn started cold. The changes:

- The system prompt is static (byte-identical for a given tool set).
- The workspace listing / memory is a `context.snapshot` event in the log, rendered as a user message before the turn's own
  message; at most one per turn, appended only when its content changed. **It is a fact in the log, so redelivery replays it byte
  for byte**; event sourcing helps here for free.
- The compaction summary is a message after the anchor, not system text.
- The summary request replays the conversation's exact prefix (same system, same tools) and only appends an instruction; no
  `tool_choice`. No summary, no compaction.
- A unit test pins the invariant: **every request is an append-only extension of the previous one**, within and across turns.

### Fix the measurement first: salt every run

The first comparison said "after is 14% pricier on pro". Not the code's fault: the provider cache lives for hours, the "before"
code was byte-identical to a run an hour earlier and hit even on step 0, while "after" had fresh prefixes with no warm cache.
Every run now prefixes the system message with a random salt: tasks within a run still share the system prompt and tool schemas
(as in production), runs share nothing. All numbers below are salted.

### Single-task bench (`my-agent`, 18 tasks × 3 samples, before / after run simultaneously)

| | Cache hit | Cost/task | Completion |
|---|---:|---:|---:|
| flash before → after | 81.6% → **86.4%** | $0.00060 → **$0.00049 (−18%)** | 100% → 98.8% |
| v4-pro before → after | 80.9% → **89.1%** | $0.00199 → **$0.00164 (−18%)** | 99.3% → 100% |

### Session bench (9 development requests, ~3 compactions, 3 sessions each)

The single-task bench runs one turn per cell, so it never exercises "across turns + compaction". New `npm run bench:session` runs
9 real requests on one thread (explore → search → add comments → write a README → cross-file rename → count lines → self-check →
CHANGELOG), meters **every** LLM call including summaries, and ends by asking for a fact from turn 1 to check compaction kept it.

| | Total hit | Summary-call hit | Cost/session | Checks |
|---|---:|---:|---:|---:|
| flash before → after | 73.9% → **86.8%** | 0% → **94.5%** | $0.00510 → **$0.00444 (−13%)** | 12/12 → 12/12 |
| v4-pro before → after | 73.1% → **86.9%** | 0% → **96.4%** | $0.01893 → **$0.01599 (−16%)** | 12/12 → 12/12 |

Prompt tokens per session actually rose 15–20%: the summary call now carries the whole conversation (before, each message was cut
to 300 characters). Nearly all of the extra hits the cache, so cost still fell.

### Four-harness comparison (salted, 432 cells, about $0.38)

| Model | harness | Completion | Cache hit | LLM calls/task | Prompt tokens/task | Cost/task |
|---|---|---:|---:|---:|---:|---:|
| flash | `my-agent` | **98.9%** | **86.8%** | 4.30 | 9,348 | **$0.00048** |
| flash | `pi` | **100.0%** | 85.1% | 4.61 | 8,526 | $0.00051 |
| flash | `react-min` | **99.3%** | 81.7% | 4.93 | 7,845 | $0.00057 |
| flash | `raw` | **89.3%** | 37.0% | 1.00 | 634 | $0.00018 |
| v4-pro | `my-agent` | **100.0%** | **88.6%** | 3.93 | 8,454 | $0.00163 |
| v4-pro | `pi` | **98.1%** | 87.9% | 4.13 | 7,485 | $0.00162 |
| v4-pro | `react-min` | **100.0%** | 86.4% | 4.50 | 6,896 | $0.00165 |
| v4-pro | `raw` | **90.6%** | 43.1% | 1.00 | 633 | $0.00046 |

`my-agent` still sends the most prompt tokens per task (more tools, more rules), but it has the highest cache hit rate: cheapest
on flash, level with the others on pro.

**Two honest caveats:**
- Round three's "28% pricier than `react-min` on pro" was measured **unsalted**: `react-min`'s requests were byte-identical to
  earlier runs and rode their leftover cache, while `my-agent` changed its requests every round. How much of that 28% was an
  artifact and how much this round removed can no longer be separated.
- This is still short of dsh's 97–99%. The ceiling is set by "new tokens per request / request length": sessions here are a few
  thousand to ten thousand tokens, so one tool output is several percent; dsh's numbers come from sessions of tens of thousands of
  tokens. The remaining misses are essentially new content (tool output, the next question, a post-compaction summary).

## Resilience: what fair weather can't measure

On the scoreboard, a 20-line while loop and a full harness score about the same — because when nothing fails, they genuinely are the same. Event sourcing only shows its value under failure. Hence a separate fault-injection suite (zero API cost, runs in seconds):

| Scenario | Injected fault | `my-agent` | `react-min` |
|---|---|:-:|:-:|
| R1 Crash recovery | Process dies at step 3 | ✅ Resumes from the break, 3 writes, not one extra | ❌ No state to recover; restart = redo, 5 writes |
| R2 Duplicate delivery | Same turn kicked twice concurrently (fresh `tool_call_id` per LLM call) | ✅ Per-thread serialization: the second runner sees `finished` and no-ops, 1 event written | ❌ Both run fully, side effect happens twice |
| R3 Dangling call | Inject an orphan `tool_call` with no result | ✅ Projection cleanup strips it, request stays clean | ❌ Context is memory-only; a crash loses everything |
| R4 Context growth | 12-turn conversation | ✅ Compaction anchor fires, message count bounded | ❌ Linear growth until the context window blows |
| R5 Crash mid-tool | Process dies after the tool ran, before `tool.result` is persisted | ✅ Intent recorded first; bash is not replay-safe → an `interrupted` result lets the model verify, the append happens once | ❌ Starts over, the append happens twice |
| | **Total** | **5/5** | **0/5** |

`raw` isn't in this table: it has no multi-step execution, so mid-run crashes don't apply — which is itself its ceiling.

> This suite runs in CI as a regression gate. **R1 genuinely failed once**: transient errors (network jitter, rate limits) were treated as terminal, the runner wrote `turn.finished{error}`, `fold` then reported the turn complete, and every re-dispatch became a no-op — the turn was permanently dead. The fix was splitting retryable failures into a separate `turn.error` event that counts without terminating; see `isRetryable` in `engine/runner.ts`.

## How to run

```bash
# Zero cost: fault injection, no API calls at all
npm run bench:resilience -w packages/bench

# 9-turn session through compaction, metering every call's cache hits (needs an API key)
npm run bench:session -w packages/bench -- --models deepseek-flash,deepseek-v4-pro --repeat 3

# Environment check — what can this machine run?
npm run bench:doctor -w packages/bench

# Full four-way comparison (needs DS_API_KEY or PROVIDER_API_KEY)
npm run bench -w packages/bench -- --repeat 5 --concurrency 5

# Pick tasks / configurations / models, or run an ablation
npm run bench -w packages/bench -- --tasks hard,retrieval --harness raw,my-agent
npm run bench -w packages/bench -- --models deepseek-v4-flash,deepseek-v4-pro
npm run bench -w packages/bench -- --no-bash          # ablate execution capability
npm run bench -w packages/bench -- --no-subagents     # ablate delegation
```

Results land in `packages/bench/results/`: `latest.md` (report) and `run-<timestamp>.json` (raw records, with full traces under `--traces`).

## Known limitations

Better stated here than pointed out later:

1. **One model family.** Only DeepSeek v4 (flash / pro). The two tiers already show the "stronger model, less harness value" trend, but confirming the reverse — a wider gap on weaker models — needs weaker models.
2. **17 tasks is small.** The dimensions are covered, but with only 1–6 tasks each, one task's variance moves a dimension's score noticeably.
3. **n=3 doesn't suppress noise.** Re-running one configuration moved it 3.8pt. Separating differences under 2pt needs n≥10 — three times the cost, though the whole run is still only a couple of dollars.
4. **`hard-03` isn't big enough.** Billed as a large workspace, it's 5.5k tokens inlined — `raw` handles it easily. Genuinely locking out a tool-less baseline needs 50k+ tokens.
5. **Not SWE-bench yet.** No real repos, no dependency installation, no cross-language work. It measures the execution layer, not coding ability. Data layer is ready; see above.
6. **Costs are an upper bound.** Cache hits aren't separated out.
