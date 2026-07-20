# E2E 测试报告

## 第三轮(2026-07-20)——生产化:鉴权强化 / 容器化 / 崩溃演练

> 目标:把项目推到「可独立部署的完整 agent 服务」。本轮改造 + 实测并重,发现并修复 3 个新 bug(BUG-11/12/13,其中两个藏在从未真正跑过的 bullmq 路径里)。
> 环境:同前(Windows + Docker pg/redis + DeepSeek);另构建并实测了 server Docker 镜像(mock provider + bullmq)。

### 结论

**单元测试 25/25 · API 回归 52/52(新增 J 组加固断言)· 容器全链路实测通过 · kill -9 崩溃恢复实测收敛 · UI 冒烟通过**。数据库 turns 全收敛,无未决缺陷。项目现在具备:盐化口令 + 过期 token、CORS 白名单、限流、健康检查、优雅退出、Dockerfile + compose 一键全栈、崩溃自愈(BullMQ stalled + sweeper + 启动恢复三道防线)。

### 本轮改造清单

| 类别 | 内容 |
|---|---|
| 鉴权 | scrypt+随机盐口令哈希(`s2$salt$hash`,timingSafeEqual);**旧 sha256 哈希登录时自动升级**(实测 `e2e_boot1` 无感迁移);token 三段式带过期(`TOKEN_TTL_HOURS`,默认 7 天);生产模式缺 `AUTH_SECRET` **拒绝启动**(容器实测 exit 1) |
| 服务加固 | `CORS_ORIGIN` 白名单(SSE 手写头按白名单回显);login 30/min + turns 10/min 内存滑窗限流(429,前端落可见提示);`GET /healthz`;`onResponse` 请求日志;SIGTERM/SIGINT 优雅退出(5s 兜底) |
| 测试 | `npm test`:decide 全分支 9 例 + fold 回放/挂起/压缩锚点/投影清洗 10 例 + auth 6 例 |
| 容器化 | server Dockerfile(node:22-alpine,仅装 server workspace,HEALTHCHECK);compose 加 `--profile prod`(pg+redis+server 一键);`.dockerignore` 防 secrets 入镜像 |
| 弹性 | runner 真·心跳定时器;sweeper 扫 running+pending;启动恢复重投孤儿 turn;kick 失败转 finish(error) 不再静默挂死 |

### 本轮新发现的 bug(全部修复)

#### BUG-11:bullmq 模式从未可用——jobId 含冒号导致 add 直接抛错

- **现象**:bullmq 模式下发 turn,SSE 只收到 start 后永久挂起;账本只有 turn.started+user.message;Redis 队列空。
- **根因**:`jobId: \`${turnId}:${Date.now()}\`` —— BullMQ 自定义 jobId **不允许含冒号**(破坏 Redis key 结构),`queue.add()` 抛错;而 kick 在 SSE hijack 之后,异常无处上报被静默吞掉(旧镜像里甚至以 unhandled rejection 直接杀死进程)。该路径此前从未被真正执行过(README 里 kill -9 演练是"作业")。
- **连带发现**:`connection: { url }` 不是 ioredis 合法字段——本地恰好默认连 127.0.0.1 才"能用",部署远程 Redis 会**悄悄连错库**。
- **修复**:jobId 改用 turnId 本身(见 BUG-12);connection 改为 `new Redis(REDIS_URL, { maxRetriesPerRequest: null })` 实例;kick 挂 `.catch` → 失败时 `bus.emit finish(error)`,客户端不再无限等。

#### BUG-12:同一 turn 可被多个 runner 并发执行,留下毒害性孤儿事件

- **现场**(测试中真实撞上):sweeper 重投 + 原 job 并发跑同一 turn,真实 LLM 每次生成**非确定的 tool_call id**,幂等 ID 挡不住 → `turn.finished` 之后落下 2 条无 result 的孤儿 `tool.call`;这类悬空 call 会被 fold 挂进 msgs,下次调用时 OpenAI 协议因「tool_calls 后缺 tool 消息」400,**毒害整个 thread**。
- **修复**(两层):
  1. **队列互斥**:`jobId = turnId` —— 同 turn 在队列中最多一个 job(BullMQ 同 id add 自动忽略),完成/失败即移除占位供重投再入。修复后复测:sweeper 误报重投期间**零双跑脏事件**(互斥的活体验证);
  2. **投影清洗**:fold 尾部剔除悬空 tool_calls 与全空 assistant 消息(账本不可变,投影时消毒)。用真实 DeepSeek 对被污染 thread 复测:正常收敛且能准确总结历史,400 不再发生。

#### BUG-13:LLM 长生成期间心跳静默,sweeper 必然误报重投

- **根因**:心跳只在 runner 每轮 iter 边界更新,而单步 LLM 生成常超 30s,sweeper 阈值 15s → 跑得好好的 turn 被判「心跳丢失」反复重投(此前全靠 BUG-12 的互斥挡着)。
- **修复**:runTurn 期间独立 5s 心跳定时器(finally 清除),LLM 生成中也持续报活。

### 崩溃演练实录(kill -9)

1. bullmq 实例(8788)发起 write_document 长 turn,LLM 生成中途 `Stop-Process -Force`;崩溃点账本仅 2 事件、turns=pending。
2. 重启实例:**BullMQ stalled 检测**在新 worker 启动时将 active 孤儿 job 移回队列立即重跑(第一道防线,~15s 内接管);此前另一场景(job 未入队的 pending 孤儿)由**启动恢复/sweeper**兜底(第二道,实测触发)。
3. 收敛结果:完整事件链 7 条(started→…→finished)、artifact 1835 字、**事件单份无重复**(确定性 ID 幂等),turns=completed。

### 容器化实测

- 缺 `AUTH_SECRET` → 启动中止 exit 1 ✓;带全量 env → healthz `{ok,store:postgres,runner:bullmq}` ✓
- 容器内完整 mock 流:搜索 → ask_user 挂起 → continue → write_document → 总结,14 事件标准链 + artifact ✓
- **架构发现(记录在 README 部署约束)**:测试中容器与遗留的 8788 实例组成双 worker 集群,job 被对方抢走后 SSE 无输出——bus 是进程内的,**bullmq 多实例需把 chunk 转播搬上 Redis pub/sub,本项目约束单实例跑**。

### 回归(全绿)

- 单元测试 25/25(`npm test`)
- API 回归 **52/52**:原 48 项 + J 组新增(healthz 字段、token 三段结构、篡改 exp→401、turns 限流 400×10+429×2);脚本收进 `scripts/api-e2e.mjs`
- UI 冒烟:旧格式 token 自动登出→重登(scrypt 升级后口令可用)→18 条历史还原→新消息流式渲染 ✓
- 落表:turns 0 条未收敛;旧账号哈希升级为 `s2$` 格式 ✓

### 测试遗留数据

本轮新增测试账号:`e2e_crash`/`e2e_container`/`ratelimit_probe`/`e2e_rl_*`/`e2e_*_<run>`,及其会话(含两个故意污染的取证 thread `thr_80bb3fb6`/`thr_9844c268`),均无害,可手动清理。

---

## 第二轮(2026-07-12 下午)

> 环境:Windows 本机(web:3000 / server:8787 / Docker Postgres:5432 + Redis:6379)· LLM:DeepSeek(思考模式)· Postgres 落库模式 · inline 执行模式
> 方法:API 层用 Node 脚本直连 8787 做 48 项断言(含真实 LLM 调用);UI 层用浏览器自动化 + DOM 断言;落表用 psql 直查账本核对。

### 结论

**API 48 项断言全过 + UI 全场景回归通过 + 落表核对一致**。本轮新发现并修复 **3 个 bug**(BUG-8/9/10,见修复记录),另完成 1 处数据修复与 1 处类型补全。当前未发现遗留缺陷。

### 本轮新发现的 bug 与修复

#### BUG-8:一进入侧边栏就有两个「新会话」可选(用户报告)

- **现象**:进入页面,左侧同时出现「+ 新会话」按钮和一个(或多个)标题为「新会话」的空会话条目。
- **根因**(两层):
  1. **残留脏数据**:BUG-7(init 双跑)修复**之前**创建的空 thread 永远留在列表里。DB 取证:`test-admin` 名下 `thr_1940c912` 与 `thr_fa71271f` 创建时间仅差 10ms,`e2e_ui` 名下两条差 7ms——正是当时双跑的产物。实测当前代码首次登录只建 1 个 thread、F5 不重复建,确认 bootedRef 修复本身有效。
  2. **设计缺陷**:每次点「+ 新会话」都**立即落库**一个空 thread,不发消息就切走的话空「新会话」会无限累积。
- **修复**(Codex/ChatGPT 式草稿态):
  - 前端「新会话」改为**纯草稿态**(`threadId=''`),不再调用 POST /api/threads;**发出第一条消息时才创建 thread**(`page.tsx` 的 `newThread/resetView/send`)。
  - 首次登录列表为空时同样进入草稿态,不再自动建 thread。
  - 清理 DB 中 3 条 0 事件、0 文档的僵尸「新会话」行(`thr_1940c912`/`thr_1f1b642f`/`thr_1d6946bb`)。
- **验证**:全新账号登录→侧边栏无条目只有按钮;连点「新会话」两次→DB 0 行;发首条消息→恰好 1 行且标题正确;F5/登出重登→不新增。

#### BUG-9:流式回复的正文/思考内容在后台标签页丢失不渲染

- **现象**:turn 结束后正文一直空着(只有思考时长和 tokens),F5 冷加载后才出现。短回复(如「收到」)整条消失。
- **根因**:打字机引擎完全依赖 `requestAnimationFrame` 排空分词队列,而 **rAF 在不可见/后台标签页不触发**——流式期间文字全部滞留队列,DOM 里的 part 永远是空串。用户切到别的标签页等回复、回来看到的就是空正文(rAF 恢复前)。自动化/无头场景 100% 复现。
- **修复**:`page.tsx` 新增 `twDrainAll()`,在收到 `finish`/`suspend` chunk 时(`queueMicrotask` 保证「先建 part 再排空」的 updater 顺序)一次性同步排空队列——**turn 终态的文本完整性不再依赖页面可见性**;可见时打字机动画行为不变。
- **验证**:后台标签页发消息,不刷新页面正文完整渲染;长文档任务切走再切回同样完整。

#### BUG-10:`/continue` 对任意 turn_id/tool_call_id 盲目追加并重跑

- **现象**(API 层审查+实测发现,三个连锁后果):
  1. 伪造参数会往事件日志追加一条孤儿 `user.confirmation`,污染后续所有 LLM 调用的消息序列,还白白触发一次 LLM 调用;
  2. 对已 finished 的 turn 重放 confirmation:runner 置 `running` → fold=finished → decide=noop 直接 return,**没人发 finish chunk**,该请求的 SSE 永久挂起;
  3. 同时 turns 表被永久卡在 `running`(DB 取证:上一轮测试遗留的 `trn_90416596` 就卡在 running,且其 turn.finished 事件明明存在)。bullmq 模式下 sweeper 会对这种 turn **无限重投**。
- **修复**(server):
  - `index.ts /continue`:先 `fold` 校验「该 turn 正挂起等待这个 tool_call」,不匹配(重放/伪造)一律**不追加、不 kick**,直接回一个 start+finish 终态流;
  - `runner.ts noop 分支`:按账本收敛 turns 表状态(suspended/completed),重复 kick 不再留下 running 残骸;
  - 数据修复:`trn_90416596` 已按账本改回 completed。
- **验证**:API 套件 F1/F2(重放零新增、fold 仍 finished)、I3(伪造 continue 返回终态流且零事件追加)全过;turns 表 17/17 全收敛。

### 一、API 层(48 项,Node 直连,全 PASS)

| 组 | 覆盖 | 数量 |
|---|---|---|
| A 认证 | 自动注册/密码错误 401/非法输入 400/api/me/无 token 401/伪造签名 401/拼接 token 401/**并发同名注册不 5xx** | 8 |
| B thread | 创建/列表+初始标题/空 detail | 3 |
| C 隔离 | 读/写/列表/**state**/**continue** 跨用户全 404 | 5 |
| D 校验 | 空文本 400/continue 缺参 400/artifact 404/空 thread fold=idle/**不存在 thread 发 turn 404** | 5 |
| E 真实 LLM turn | SSE 协议头/start→text-delta→usage→finish 序列/4 事件按序落库/usage 持久化/文本持久化/标题自动化/**updated_at 刷新** | 10 |
| G 挂起/恢复 | suspend chunk/finish=tool-calls/turn.suspended 落库/**fold=suspended**/continue 后 finish=stop/8 事件完整链/回复含所选/fold=finished | 8 |
| F 幂等 | 重放 confirmation 零新增(12→12)/重放不重跑 | 2 |
| H artifacts | write_document 返回 id/免鉴权可读/detail 列表含 id/tool-input-start 信号 | 4 |
| I 边界 | 超长输入截断 4000/超长输入正常收敛/伪造 continue 终态流零追加 | 3 |

测试脚本:`api-e2e.mjs`(会话 scratchpad,可随时复跑;每轮用随机后缀账号,不污染既有数据)。

### 二、UI 层(真实浏览器,全 PASS)

- 登录/注册/错误密码提示(401「密码错误」)/登出→重登数据还原
- 草稿态:新账号进入无条目、连点新会话不落库、首条消息懒建 thread、标题自动取前缀
- 流式:思考条(实时+已思考 N 秒)、短回复正文完整(BUG-9 回归)、tokens 跨步累加(↑1.4k ↓114)
- ask_user 全链路:挂起卡(问题+选项+自由输入)→ 点选 → ✓ 已答 → 恢复推理 → 最终回复含所选
- 工具流:3 个联网搜索卡(人话摘要+条数)、撰写文档卡(准备中「约 N 字」→ 已生成)、活动指示器「正在撰写 · 约 2003 字…」
- 切换串扰回归:运行中切到草稿 → 0 消息/ready/8 秒零泄漏;切回 → 16→18 条完整重建
- **运行中切回重连**:turn 仍在跑时切回 → status=streaming + 活动指示器恢复(「正在撰写 · 约 804 字…」)→ 最终收敛,文档徽标 +1
- 文档面板:徽标计数、列表、渲染态预览(标题元素+表格+3470 字)、原文链接(跟随 hostname)
- F5 冷加载:12 消息/5 工具卡/文档 1/选中会话全还原
- 侧边栏收起/展开

### 三、落表核对(psql 直查,全一致)

- 事件账本:`turn.started`=17 与 `turn.finished`=17 严格配对;挂起 turn 的 8 事件链完整有序
- `turns` 表:修复后 17/17 全部 completed/suspended 收敛,无 stale running
- `artifacts`:5 篇文档每篇都有对应 `tool.result` 事件(账本↔落表双向一致)
- 僵尸 thread:清理后为 0;新建路径已从源头堵住
- **compaction 实测生效**:事件数过 30 阈值后自动产生 `compaction.summary` 锚点(摘要质量良好);跨锚点提问「我们刚才决定吃什么」正确答出「火锅」,证明摘要注入 + 锚点后折叠工作正常
- server 在本轮多次 tsx watch 热重启(改 index.ts/runner.ts 触发),数据全程存活——Postgres 持久化直接验证通过
- 类型检查:补 `@types/pg` 后 `tsc --noEmit` server/web 双包干净

### 四、已知限制(非 bug,记录在案)

1. 切回运行中会话时,已流过的 step 中途增量不回放(持久化为 step 粒度),从重连点续起;turn 终态一定完整(BUG-9 修复保证)。
2. 鉴权为学习级:HMAC 默认密钥(生产需设 AUTH_SECRET)、无 token 过期、sha256 未加独立盐。
3. CORS 全放开(origin:true + SSE 头 *),部署时应收紧到前端域名。
4. bullmq 模式(RUNNER_MODE=bullmq)本轮未跑(当前 dev server 为 inline 模式,切换需重启用户的 server);sweeper 无限重投的隐患已通过 runner noop 收敛提前堵住。
5. 并发对同一 suspended turn 发两个 continue 的极端竞态下,LLM 可能被调用两次(事件层有确定性 ID 兜底,不会写重)。
6. e2e 测试账号(e2e_a_*/e2e_b_*/e2e_ui/e2e_boot1/e2e_race_*)与会话留在库中,可手动清理。

---

## 第一轮(2026-07-12 上午,历史存档)

> 执行日期:2026-07-12 · 环境:Windows 本机(web:3000 / server:8787 / Docker Postgres:5432 + Redis:6379)· LLM:DeepSeek(思考模式)
> 方法:通过浏览器页面内 fetch 做 API 级断言(可直达本机端口),UI 交互用浏览器自动化,DOM 断言验证渲染结果。

### 结论

**51 项断言全部通过**(API 34 + UI 17)。过程中发现并修复 1 个新 bug(BUG-7);2 项初判 FAIL 复核后确认为测试时序误报(turn 在切换期间正常完成,行为正确)。

### 一、API 层(34 项,不依赖 UI)

认证 A1-A6 / thread B1-B3 / 隔离 C1-C3 / 校验 D1-D4 / 真实 LLM turn E1-E9 / 幂等 F1-F2 / 挂起恢复 G1-G7 —— 全部 PASS(明细见 git 历史版本)。

### 二、UI 层(17 项,真实浏览器)

- 登录页渲染、UI 注册新账号进入 —— PASS
- 发送消息 → 思考条(已思考 N 秒 + 预览)、3 个联网搜索卡(人话摘要)、撰写文档卡「正在撰写内容…」、活动指示器「正在撰写…」 —— PASS
- **切换串扰回归(H 组)**:运行中切到空会话 → 消息区干净(0 条)、状态 ready、等待 2 秒无泄漏渲染;切回 → 历史 parts 完整重建 —— H1-H4 PASS
  - H5/H6 初判 FAIL → 复核:turn 在切换期间已正常完成(全部工具「完成」、文档已生成),ready 是正确状态,**判定为测试时序误报而非缺陷**
- tokens 汇总渲染、最终 markdown 文本渲染 —— PASS
- 文档面板:计数徽标、列表、渲染态预览(含标题元素、正文 >200 字)、原文链接 —— I1-I5 PASS
- **F5 冷加载(J 组)**:消息数/工具卡数/文档数/会话列表/选中会话全部还原 —— J1-J5 PASS
- **登出→重登(K 组)**:会话列表与消息完整还原(数据在服务端,非浏览器缓存) —— K1-K4 PASS

## 发现与修复记录(全程累计)

| # | Bug | 根因 | 修复 |
|---|---|---|---|
| 1 | SSE 端点被浏览器 CORS 拦截 | reply.hijack() 后 @fastify/cors 失效 | fc07468 |
| 2 | 流式文本重复、工具卡片双份 | React StrictMode 双跑非纯 setState updater | 94f88fb |
| 3 | 长文档流式渲染卡死页面 | 每 delta 全量深拷贝+重渲染压垮主线程 → 分词队列+rAF 合帧 | 94f88fb |
| 4 | write_document 前长时间无反馈 | 工具参数流式生成期间无信号 → tool-input-start/delta 协议 | 4537b71 |
| 5 | artifact 链接硬编码 localhost | → 跟随页面 hostname + rewrites 代理 | e3ad2e8 |
| 6 | 运行中切换会话内容串扰 | SSE 流未中止且 chunk 无 thread 作用域 → AbortController+viewRef | 7a6a90a |
| 7 | 侧边栏出现两个「新会话」(初修) | StrictMode 双跑 useEffect → init() 创建两个 thread → bootedRef 防重入 | 94a95b0 |
| 8 | 「新会话」残留/累积(BUG-7 续) | 空 thread 立即落库 + 旧脏数据永驻列表 → 草稿态懒建 + 数据清理 | 本次提交 |
| 9 | 后台标签页流式正文丢渲染 | 打字机仅靠 rAF 排空,后台标签页 rAF 不触发 → finish/suspend 时 twDrainAll 同步排空 | 本次提交 |
| 10 | /continue 盲目追加+重跑 | 无挂起校验:伪造参数污染日志、重放挂死 SSE、turns 卡 running(sweeper 会无限重投)→ fold 校验 + noop 收敛 | c524513 |
| 11 | bullmq 模式完全不可用 | jobId 含冒号 queue.add 抛错,hijack 后异常被吞 → jobId 规范化 + connection 用 ioredis 实例 + kick 失败转 finish(error) | 第三轮 |
| 12 | 同 turn 并发重跑留毒害性孤儿 tool.call | 非确定 call_id 穿透幂等 → jobId=turnId 队列互斥 + fold 投影清洗悬空 call | 第三轮 |
| 13 | LLM 长生成期间 sweeper 误报重投 | 心跳只在 iter 边界更新 → runner 独立 5s 心跳定时器 | 第三轮 |
| - | 文件同步竞态截断(web-search.ts/index.ts 等) | 沙箱挂载缓存 | 8f1a-系列修复 commit |
