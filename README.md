# Dura-Agent

素瓷 · 墨 —— 一个事件驱动的开源 Agent 系统。

**事件日志是唯一真相,状态是折叠,行为是纯函数,执行是队列任务。** 前后端真分离,可独立部署;零依赖即可本地跑通全流程。

## 特性

- **事件溯源内核**:所有对话/工具调用/挂起恢复都是追加事件,`fold(events) → state` 纯函数折叠,刷新页面 = 从日志重建同一真相
- **素瓷·墨界面**:暖白瓷底 + 毛玻璃层次 + 克制的水墨动效;状态以落款小字呈现,无任何"AI 味"指示灯;整站唯一红色是朱砂印 logo
- **Provider 可插拔**:OpenAI-compatible 统一协议,换 env 即换模型(DeepSeek / GLM / Qwen / OpenAI / 自建网关)
- **崩溃收敛**:BullMQ 模式下 `kill -9` 中途进程,心跳 sweeper 重投任务,确定性事件 ID 保证重放幂等,turn 自动收敛完成
- **挂起/恢复**:`ask_user` 工具将 turn 挂起等待人工确认,`/continue` 恢复——client tool 的完整 wire

## 架构

| 概念 | 实现 | 文件 |
|---|---|---|
| 事件日志(唯一真相) | `agent_events` 表 / MemoryStore | `apps/server/src/store.ts` |
| fold(events)→state | `fold()` 纯函数 | `apps/server/src/engine/fold.ts` |
| decide(state)→commands | `decide()` 纯函数 | `apps/server/src/engine/decide.ts` |
| 执行引擎 | `runTurn()` + inline/bullmq 双模式 | `engine/runner.ts`、`queue.ts` |
| 幂等(重写=没写) | `eventId()` sha1 内容哈希 | `store.ts` |
| 崩溃恢复 | `heartbeat_at` + sweeper 定时重投 | `queue.ts` |
| 实时投影 | bus + SSE 流式响应 | `bus.ts`、`index.ts` |
| 人工确认 | `turn.suspended` 事件 + `/continue` | `runner.ts`、`fold.ts` |
| 上下文压缩 | `compaction.summary` 摘要锚点事件 | `runner.ts`(maybeCompact) |
| 技能 | markdown 注入 system prompt | `skills.ts`、`skills/*.md` |
| LLM 抽象 | `ChatProvider` 接口 + openai-compat + mock | `llm/` |
| 前端 | 同一日志两个投影:SSE reducer / 冷加载重放 | `apps/web/app/page.tsx` |

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

要同时接多家模型,推荐自建 [new-api](https://github.com/QuantumNous/new-api) / one-api 网关:它把所有厂商统一成 OpenAI 协议,`PROVIDER_BASE_URL` 指向网关即可,模型切换在网关侧完成——协议归一,provider 可插拔。要原生接 Anthropic 协议,照 `llm/openai-compat.ts` 的接口再写一个 adapter 即可(`ChatProvider` 是唯一契约)。

## 持久化(Postgres)——建议尽早开启

Memory 模式下 **server 一重启(包括 tsx watch 热重载)事件日志就清空**。落库:

```bash
docker compose up -d          # 起本地 pg + redis(需要 Docker Desktop)
# 然后在 .env.local 加一行:
# DATABASE_URL=postgres://duraagent:duraagent@localhost:5432/duraagent
npm run dev:server            # 启动日志出现 "[store] Postgres 模式" 即生效
```

首次连接自动建 4 张表:`agent_events`(事件日志)、`threads`、`turns`、`artifacts`。没有 Docker 的话,Supabase/Neon 免费档拿一条连接串填 `DATABASE_URL` 一样用。

## 生产模式(+ Redis 队列)

```bash
RUNNER_MODE=bullmq REDIS_URL=redis://localhost:6379 npm run dev:server
```

**崩溃演练**:bullmq 模式下,生成中途 `kill -9` server 进程再重启——sweeper 检测心跳丢失、任务重投、fold 重放日志、确定性 ID 去重,turn 收敛完成。

## 部署

**一键全栈(Docker)**:

```bash
# .env.local 里必须设 AUTH_SECRET(openssl rand -hex 32)和 PROVIDER_*,建议设 CORS_ORIGIN
docker compose --profile prod up -d --build   # pg + redis + server 容器(bullmq 模式)
curl http://localhost:8787/healthz            # {"ok":true,...}
```

分开部署:

- **web → Vercel**:root 指向 `apps/web`,env 配 `NEXT_PUBLIC_API_HOST=https://你的后端域名`
- **server → 云主机/容器**:SSE 需要长连接(Serverless 函数对流式响应和常驻 worker 不友好);`docker build` 本目录镜像,或 `tsx src/index.ts` 直跑
- **Postgres**:RDS / Supabase / Neon 均可(只需 `DATABASE_URL`)
- **Redis**:bullmq 模式才需要;inline 模式可以先不配

上线检查单(缺 AUTH_SECRET 时生产模式会拒绝启动):

| 项 | env | 说明 |
|---|---|---|
| 签名密钥 | `AUTH_SECRET` | **必须**;token 与口令哈希的根密钥 |
| CORS | `CORS_ORIGIN` | 逗号分隔前端域名;不设=全放开(仅开发) |
| token 有效期 | `TOKEN_TTL_HOURS` | 默认 168(7 天) |
| 限流 | `RATE_LOGIN_PER_MIN` / `RATE_TURNS_PER_MIN` | 默认 30 / 10,0=关 |
| 健康检查 | `GET /healthz` | 容器/负载均衡探针 |

**部署拓扑约束**:
1. 同一个 Postgres 只跑**一种** runner 模式;inline 模式只能**单实例**(崩溃恢复靠启动时重投)。
2. bullmq 模式下 turn 由 worker 执行,SSE 由执行者进程的 bus 发出——**多实例水平扩容需要把 chunk 转播搬到 Redis pub/sub**,本项目未实现,故 bullmq 也应单实例跑(gateway 与 worker 同进程)。

## 设计语言:素瓷 · 墨

- **底色**:暖白瓷(`#f7f6f3`)+ 淡墨晕 + 纸纹颗粒;侧栏、顶栏、输入舱、工具卡是不同厚度的毛玻璃,对话流从玻璃下穿过
- **点缀**:黛蓝(`#46627f`)用于链接与焦点;墨色(`#2e3238`)用于实心控件;朱砂(`#a63b2a`)只出现在印章 logo 上
- **状态**:落款式小字(就绪 / 候示 / 思考中 / 调用中 / 书写中),没有彩色指示灯
- **动效**:就绪态完全静止;思考/调用时状态旁一粒墨滴晕开;书写时题下一线墨色缓流;新对话空状态一笔墨圈只描一次。全部尊重 `prefers-reduced-motion`

## 测试

```bash
npm test        # decide/fold/auth 纯函数单测(node:test,25 用例)
```

端到端测试记录见 [TESTING.md](./TESTING.md)(三轮:API 48 断言 / UI 全场景 / 崩溃演练与容器化实测)。

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
dura-agent/
├─ packages/protocol/        # 共享类型:事件、chunk、DTO(零依赖)
├─ apps/server/              # Fastify gateway + 引擎
│  ├─ src/engine/            # fold / decide / runner(核心,先读这里)
│  ├─ src/llm/               # provider 抽象 + openai-compat + mock
│  ├─ src/tools/             # web_search / write_document / ask_user
│  ├─ src/{store,queue,bus,skills}.ts
│  └─ skills/                # markdown 技能
└─ apps/web/                 # Next.js 聊天前端(SSE 消费 + reducer + 冷加载)
```

## License

[MIT](./LICENSE)
