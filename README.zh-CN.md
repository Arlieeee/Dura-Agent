# Dura-Agent — 事件驱动 Agent 框架

[English](./README.md) | **中文**

从零实现的事件驱动 agent 框架:**事件日志是唯一真相,状态是折叠,行为是纯函数,执行是队列任务**。前后端真分离,可独立部署。

## 核心设计

| 概念 | 实现 | 文件 |
|---|---|---|
| agent_events 事件日志 | `agent_events` 表 / MemoryStore | `apps/server/src/store.ts` |
| fold(events)→state | `fold()` 纯函数 | `apps/server/src/engine/fold.ts` |
| decide(state)→commands | `decide()` 纯函数 | `apps/server/src/engine/decide.ts` |
| runner + BullMQ | `runTurn()` + inline/bullmq 双模式 | `engine/runner.ts`、`queue.ts` |
| 确定性事件 ID(重写=没写) | `eventId()` sha1 内容哈希 | `store.ts` |
| 心跳 + sweeper + 重投 | `heartbeat_at` + sweeper 定时器 | `queue.ts` |
| SSE 实时投影 | bus + `/turns` 流式响应 | `bus.ts`、`index.ts` |
| ask_user 挂起/恢复 | `turn.suspended` 事件 + `/continue` | `runner.ts`、`fold.ts` |
| 喊停 | `user.interrupt` 持久事件 + `AbortSignal` 打断流 + `/cancel`;连带子 agent | `runner.ts`(cancelTurn)、`decide.ts` |
| 同 thread 串行 | 准入门禁(未收尾的 turn → 409)+ runner 进程内 thread 锁 | `index.ts`、`runner.ts`(withThreadLock) |
| compaction 摘要锚点 | `compaction.summary` 事件;摘要请求原样重放主对话前缀,只追加指令 | `runner.ts`(maybeCompact) |
| 大工具结果溢出 | 超出内联预算的结果全文写进 `.dura/spill/`,上下文只留头尾 + 路径提示(原先是悄悄截断) | `engine/tool-output.ts`、`runner.ts` |
| 请求只追加 | system 纯静态;工作区清单 / 记忆是 `context.snapshot` 事件,渲染成 user 消息 —— 每个请求都是上一个请求的延伸(有单测) | `prompt.ts`、`fold.ts` |
| 可插拔工具网关 | 工具注册表(chat / coding / memory 三组)+ 只读工具并发执行 | `tools/index.ts` |
| 任务隔离沙箱 | per-thread 工作区 + 路径逃逸防护 | `workspace.ts` |
| subagent 委派 | `delegate` 工具:子 agent = 另一个 thread 里的普通 turn | `tools/delegate.ts` |
| 跨 session 记忆 | 索引常驻提示词 + 正文按需 `recall` | `memory.ts`、`tools/memory.ts` |
| skills | markdown 注入 system prompt + `allowed-tools` 工具白名单 | `skills.ts`、`skills/*.md` |
| LLM provider | OpenAI-compatible 统一抽象 + mock | `llm/` |
| 前端 reducer/冷加载/重连 | 同一日志两个投影 | `apps/web/app/page.tsx` |

## 和市面上的框架什么关系

| 框架 | 它的取法 | 本项目的取法 |
|---|---|---|
| **[Pi](https://github.com/badlogic/pi-mono)**(Mario Zechner) | 极简主义:4 个核心工具(read/write/edit/bash)+ 1000 token 以内的系统提示词;会话用 append-only JSONL 树,天然支持分支 | 工具面与提示词纪律**直接借鉴它**(`edit` 用精确替换而非 diff、提示词压到最短)。差别在持久层:它的 JSONL 树擅长分支回溯,我们的事件日志 + `fold` 擅长**崩溃恢复与幂等** —— 见 [BENCHMARK 韧性评测](./BENCHMARK.md#韧性评测顺风局测不出来的东西) |
| **LangChain / LangGraph** | 图结构编排,节点/边显式建模,生态最大 | 不做图。整个编排是一个纯函数 `decide(state) → command`,能单测、能回放。代价是复杂拓扑要自己写 |
| **[DeerFlow](https://github.com/bytedance/deer-flow)**(字节) | SuperAgent harness:LangGraph checkpointer + 容器/K8s 沙箱 + subagent 委派 + 跨 session 持久记忆 + IM 网关。面向"跑几分钟到几小时"的长程任务 | 持久化思路同源(它用 LangGraph checkpointer,我们用事件日志)。**它的 subagent 委派与跨 session 记忆是本项目明确的缺口**,见 [ROADMAP](./ROADMAP.md)。反过来,它的沙箱是容器级、我们只是路径级,这点也写在 `bash.ts` 的声明里 |
| **[Hermes](https://github.com/NousResearch)**(Nous Research) | 五层架构:Instructions / Constraints / Feedback / **Memory** / Orchestration;核心是 SKILL.md —— agent 自己写的持久记忆,越用越顺手 | 五层里唯一缺的 Memory 已补上(`memory.ts` + `remember`/`recall`)。形态与它、DeerFlow、Claude Code 三家高度一致 —— **索引常驻 + 正文按需**,说明这是收敛过的答案 |
| **Claude Code** | 权限检查贯穿每次工具调用(hook / user / **classifier** 三种批准来源);`memdir` 用小模型 side query 从 manifest 里选 top-5 记忆 | 记忆的两级结构直接照它学的。它的**分类器判 bash 安全性**比本项目的正则黑名单更对 —— 已列入 [ROADMAP](./ROADMAP.md),`bash.ts` 里也写明了黑名单的局限 |
| **Temporal** | 通用 durable execution,事件日志重放恢复 | 思想同源(日志即唯一真相、重放即恢复),但它是通用工作流引擎;这里把同一套思想收窄到 agent 语义上,少一个中间件依赖 |
| **Claude Agent SDK / Google ADK** | 官方 SDK,events + runner 模型 | 事件模型接近。本项目额外把"事件是唯一真相"贯彻到前端:同一份日志,SSE 增量投影和冷加载全量投影走两条路得到同一结果 |

一句话:**Pi 证明了极简工具面就够用,Temporal 证明了事件日志能扛崩溃,DeerFlow 证明了长程任务还需要委派与记忆 —— 这个项目取前两者,并用 [bench](./BENCHMARK.md) 量出各自值多少分。**

> 一个有意思的交叉验证:DeerFlow 的文档里提到它要给"悬空的 tool_call 注入占位结果"(*injects placeholder tool results for dangling calls*),
> 而本项目在 `fold` 里是**剔除**这些孤儿 call(没开工的那种;开工了没结果的见下)。两个独立框架被同一个问题逼到墙角 —— 崩溃残留的无 result 工具调用会让下一次 API 请求 400,
> 毒死整个会话。解法不同(补齐 vs 剔除),但这条坑是所有事件驱动 agent 的必经之路。本项目把它固化成了[韧性评测 R3](./BENCHMARK.zh-CN.md#韧性评测顺风局测不出来的东西)。
> 更难受的是**开工了没结果**的那种:副作用已经发生,结果没落盘。runner 执行前先追加 `tool.started`,
> 重投时只重跑声明了可安全重跑的工具(只读、整文件覆盖写、确定性子任务),其余补一个 `interrupted` 结果,让模型先核实现状 —— 韧性评测 R5。

## 快速开始(零依赖,30 秒)

```bash
npm install
npm run dev:server        # :8787,Memory 存储 + mock LLM + inline 执行
npm run dev:web           # :3000
```

打开 http://localhost:3000,发"搜一下 event sourcing,整理给我"——会完整经历:
`web_search → ask_user 挂起(选文档/回答)→ write_document → 总结`。

试试中途**刷新页面**:冷加载从事件日志重建一模一样的内容(同一真相的两个投影)。

## 接真实 LLM

统一走 OpenAI-compatible 协议,换 env 即换模型:

```bash
PROVIDER=openai-compat
PROVIDER_BASE_URL=https://api.deepseek.com/v1   # 或 GLM/Qwen/OpenAI 端点
PROVIDER_API_KEY=sk-xxx
PROVIDER_MODEL=deepseek-chat
```

要同时接 claude/openai/glm/deepseek 多家?推荐自建 [new-api](https://github.com/QuantumNous/new-api) / one-api 网关:它把所有厂商统一成 OpenAI 协议,本项目 `PROVIDER_BASE_URL` 指向网关即可,模型切换在网关侧完成——这正是"协议归一,provider 可插拔"的工程做法。要原生接 Anthropic 协议,照 `llm/openai-compat.ts` 的接口再写一个 adapter 即可(`ChatProvider` 是唯一契约)。

## 持久化(Postgres)——强烈建议尽早开启

Memory 模式下 **server 一重启(包括 tsx watch 热重载)事件日志就清空**,对话和文档全丢。落库:

```bash
docker compose up -d          # 起本地 pg + redis(需要 Docker Desktop)
# 然后在 my-agent/.env.local 加一行:
# DATABASE_URL=postgres://myagent:myagent@localhost:5432/myagent
npm run dev:server            # 启动日志出现 "[store] Postgres 模式" 即生效
```

首次连接会自动建 4 张表:`agent_events`(事件日志,唯一真相)、`threads`、`turns`、`artifacts`。验证持久化:聊几句 → 重启 server → 刷新页面,历史还在。没有 Docker 的话,Supabase/Neon 免费档拿一条连接串填 `DATABASE_URL` 一样用。

## 生产模式(+ Redis 队列)

```bash
RUNNER_MODE=bullmq REDIS_URL=redis://localhost:6379 npm run dev:server
```

**崩溃演练**:bullmq 模式下,生成中途 `kill -9` server 进程再重启——sweeper 检测心跳丢失、任务重投、fold 重放日志、确定性 ID 去重,turn 收敛完成。这就是收敛式重跑。

## 部署

**一键全栈(Docker)**:

```bash
# .env.local 里必须设 AUTH_SECRET(openssl rand -hex 32)和 PROVIDER_*,建议设 CORS_ORIGIN
docker compose --profile prod up -d --build   # pg + redis + server 容器(bullmq 模式)
curl http://localhost:8787/healthz            # {"ok":true,...}
```

分开部署:

- **web → Vercel**:root 指向 `my-agent/apps/web`,env 配 `NEXT_PUBLIC_API_HOST=https://你的后端域名`
- **server → 阿里云/腾讯云**:SSE 需要长连接,**建议轻量服务器/ECS/容器**(Serverless 函数对流式响应和常驻 worker 不友好);`docker build` 本目录镜像,或 `tsx src/index.ts` 直跑
- **Postgres**:RDS / Supabase / Neon 均可(只需 `DATABASE_URL`)
- **Redis**:云 Redis(bullmq 模式才需要;inline 模式可以先不买)

上线检查单(缺 AUTH_SECRET 时生产模式会拒绝启动):

| 项 | env | 说明 |
|---|---|---|
| 签名密钥 | `AUTH_SECRET` | **必须**;token 与口令哈希的根密钥 |
| CORS | `CORS_ORIGIN` | 逗号分隔前端域名;不设=全放开(仅开发) |
| token 有效期 | `TOKEN_TTL_HOURS` | 默认 168(7 天) |
| 限流 | `RATE_LOGIN_PER_MIN` / `RATE_TURNS_PER_MIN` | 默认 30 / 10,0=关 |
| 健康检查 | `GET /healthz` | 容器/负载均衡探针 |

**部署拓扑约束**(说清楚边界,这也是真实的分布式课题):
1. 同一个 Postgres 只跑**一种** runner 模式;inline 模式只能**单实例**(崩溃恢复靠启动时重投)。
2. bullmq 模式下 turn 由 worker 执行,SSE 由执行者进程的 bus 发出——**多实例水平扩容需要把 chunk 转播搬到 Redis pub/sub**,本项目未实现,故 bullmq 也应单实例跑(gateway 与 worker 同进程)。

## 测试与评测

```bash
npm test                                       # 引擎单测:fold/decide/auth/工具层/turn 控制面(node:test,78 用例)
npm test -w packages/bench                     # 评测 oracle 自测(41 断言:标准解满分 / 空手扣分 / 作弊判 0)
npm run bench:resilience -w packages/bench     # 故障注入对比,零 API 成本
npm run bench -w packages/bench -- --repeat 5  # 四档 harness 全量跑分(需 API key)
npm run bench:session -w packages/bench        # 9 轮会话、跨压缩,记录每次调用的缓存命中(需 API key)
```

端到端测试记录见 [TESTING.md](./TESTING.md)(三轮:API 48 断言 / UI 全场景 / 崩溃演练与容器化实测)。

**评测**:本项目自带一套 harness 对照 bench —— 同一模型、同一套工具、同一端点,只换执行层,
量化"加了 harness 到底值多少分"。方法论、任务集与结果见 [BENCHMARK.md](./BENCHMARK.md)。

四档配置:`raw`(原生 API 单次调用,无工具无循环)/ `react-min`(教程里那个 20 行循环)/
`my-agent`(完整 harness)/ `pi`([Pi](https://github.com/earendil-works/pi) 的 agent loop,真实第三方框架对照)。

## 上手练习(按难度递增)

1. 读 `fold.ts` + `decide.ts`,给 decide 写单测(纯函数,无需任何 mock 基础设施)
2. 打开 `GET /api/threads/:id/state?turn_id=xxx`,观察任意时刻的折叠结果
3. 加一个新 server tool(如 `calculator`),体会"新功能=新事件流经既有机制"
4. 加一个新 client tool(如 `confirm_cost` 费用确认),复用挂起 wire,零新协议
5. bullmq 模式做 kill -9 演练,观察日志里的"幂等命中(no-op)"
6. 实现"分支/重新生成":fold 到指定 seq 后开新 turn(日志不可变,旧分支还在)
7. 给 provider 写 Anthropic 原生 adapter;或部署 new-api 网关多模型切换
8. 把 compaction 阈值调小(COMPACT_THRESHOLD=6),观察摘要锚点如何生效

## 目录

```
my-agent/
├─ packages/protocol/        # 共享类型:事件、chunk、DTO(零依赖)
├─ packages/bench/           # harness 对照评测(见 BENCHMARK.md)
│  ├─ src/harness/           # raw / react-min / my-agent 三档适配器
│  ├─ src/tasks/             # 21 道带 oracle 的沙箱任务
│  ├─ src/{runner,score,report}.ts
│  └─ src/resilience.ts      # 故障注入:崩溃恢复/重复投递/悬空调用/上下文膨胀
├─ apps/server/              # Fastify gateway + 引擎
│  ├─ src/engine/            # fold / decide / runner(核心,先读这里)
│  ├─ src/llm/               # provider 抽象 + openai-compat + mock
│  ├─ src/tools/             # 注册表 + chat 组(搜索/文档/追问)+ coding 组(读写改/检索/bash)
│  ├─ src/{store,queue,bus,skills,workspace,prompt}.ts
│  └─ skills/                # markdown 技能
└─ apps/web/                 # Next.js 聊天前端(SSE 消费 + reducer + 冷加载)
```
