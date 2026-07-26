# 参与开发

[English](./CONTRIBUTING.md) | **中文**

## 本地起步

```bash
npm install
npm run dev:server        # :8787,Memory 存储 + mock LLM + inline 执行,零依赖
npm run dev:web           # :3000
```

不配任何 key 就能跑通全链路(mock provider 是确定性脚本)。接真模型见 [README](./README.md#接真实-llm)。

## 提 PR 前跑这四条

```bash
npx tsc --noEmit -p apps/server && npx tsc --noEmit -p packages/bench
npm test                                       # 引擎单测
npm test -w packages/bench                     # 评测 oracle 自测
npm run bench:resilience -w packages/bench     # 故障注入回归(零 API 成本)
```

CI 跑的就是这四条,全绿才合。

## 改动指引

**加工具** — 在 `apps/server/src/tools/` 写实现,用 `defineTool()` 登记,选好 `group`(`chat` 还是 `coding`)。
不用改 runner、不用改协议。client tool(需要用户答复的)加 `client: true`,挂起/恢复走既有 wire。

**改引擎** — `fold` 和 `decide` 是纯函数,没有 I/O,直接写单测,不需要任何 mock 基础设施。
改它们之前先想清楚:**新行为能不能表达成一个新事件类型?** 事件只加不改,这是整套设计的地基。

**加评测题** — 在 `packages/bench/src/tasks/` 里 push 一个 `BenchTask`,同时在
`test/oracle.test.ts` 的 `GOLDEN` 里给一份标准解。没有标准解的题不收 ——
oracle 自己判不准的话,跑出来的分只是噪音。

**碰持久化** — Memory 与 Postgres 两个实现要同步改,`store.ts` 里挨着放,别只改一个。

## 几条不成文的约定

- 注释写"为什么这么做",不写"这行在干什么"。尤其是那些看起来可以简化、实际不能简化的地方。
- 错误信息要能指导下一步。`old_string 在 x.ts 中匹配到 3 处。加上下文让它唯一` 比 `edit failed` 有用得多。
- 边界要说清楚而不是装作没有。`bash.ts` 顶部那段"这不是沙箱"的声明就是范例。
- 新功能优先表达成"新事件流经既有机制",而不是新开一条旁路。

## 目录

见 [README 的目录章节](./README.md#目录)。先读 `apps/server/src/engine/` 三个文件,那是整个系统的核心。
