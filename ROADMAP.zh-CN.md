# Roadmap

[English](./ROADMAP.md) | **中文**

按"能不能被 bench 量出来"排序。量不出来的功能不排期 —— 加了也不知道有没有用。

## 缺口来自哪

对着 [Pi](https://github.com/earendil-works/pi)(极简 coding agent)和
[DeerFlow](https://github.com/bytedance/deer-flow)(长程 SuperAgent harness)逐项比对后,
真正缺的是这三样。其余差异要么已经补上,要么是刻意不做。

### ✅ 1. Subagent 委派(已实现)

`delegate(goal, max_steps?)` 是一个 server tool:子 agent = **另一个 thread 里的一个普通 turn**,
复用同一个 `runTurn`、同一个工作区,因此天然继承幂等、崩溃恢复与可审计性。

隔离靠 **thread 边界**完成:`fold` 是按 thread 加载事件的,子 agent 的中间消息
根本不会出现在父 turn 的投影里 —— 不需要给 `fold` 加任何过滤逻辑。
子 thread ID 由父 turn + `tool_call_id` 确定性派生,所以父 turn 重投不会把子任务重跑一遍。

深度上限 `MAX_DELEGATE_DEPTH`(默认 2);拿不到 `spawn` 注入时 delegate 不上架。
测试见 `test/subagent.test.ts`(隔离性 / 上下文体积 / 深度 / 重放幂等)。

**还没做**:子 agent 的独立工具白名单(DeerFlow 有),现在继承父 agent 的工具集。

**但它还没被证明有价值。** 在专门为它设计的 `hard-04`(3 子系统 × 6 文件)上,
模型 6/6 次都选择自己读完 18 个文件,一次都没调 `delegate` —— 而且它的选择是对的,
18 个文件远不到上下文装不下的程度。要真正量出委派的收益,得造出**几十个子任务、
每个都要多轮探索**的场景,让不委派就必然撞预算上限。这是下一步该补的评测,
不是给 delegate 加功能。

### ✅ 2. 跨 session 持久记忆(已实现)

Hermes 五层架构(Instructions / Constraints / Feedback / **Memory** / Orchestration)里唯一缺的那层,
DeerFlow 和 Claude Code 也都有。三家的形态高度一致,说明这是收敛过的答案:

```
memory/
  MEMORY.md      索引:一行一条,常驻 system prompt
  <slug>.md      单条记忆:frontmatter 的 name/description/type,正文按需加载
```

**两级结构的意义是成本**:索引小到可以常驻,正文再多也不占上下文,直到 `recall` 取出来。
一股脑全塞进 system prompt 的做法,记忆越多 agent 越笨。

检索用**词重叠打分**而不是再调一次 LLM(Claude Code 是用小模型做 side query 选 top-5)。
理由是评测:LLM 选择器会把"记忆有没有用"和"选择器准不准"搅在一起,而且每次 recall 多一次调用。
确定性打分笨,但可单测、零成本、结果可复现。

**还没做**:跨 thread 的评测任务(第一轮告知偏好、第二轮检验是否记得)。
现有 bench 每题一个全新沙箱,天然是单 thread 的,要测记忆得先扩协议 —— 所以现在
记忆层有单测(`test/memory.test.ts`)但**没有 benchmark 分数**,和 subagent 一样属于"还没被量出价值"。

### ✅ 3. Skills 的 allowed-tools 策略(已实现)

skill 的 frontmatter 里写 `allowed-tools: a, b, c`,框架据此收窄工具面。两层拦截:
**不上架**(模型看不见)+ **执行前再查一次**(挡幻觉与提示词注入)。多技能同时生效时求交集。

有一个作用域问题值得记下来:最初的实现让"技能文件存在就生效",结果一个只声明了
`web_search/write_document` 的写作技能,把 coding 场景的工具全掐没了 —— 单测当场挂掉。
DeerFlow 的语义是"技能**激活后**才限定",而本项目还没有激活机制(技能常驻注入),
所以改用近似判据:**技能声明的工具与当前工具集没有交集,就认为它与本场景无关,不参与收窄**。
真正的解法还是补一套技能激活机制。

### 4. bash 权限该用分类器,不是黑名单(新增)

读 [Claude Code 源码](https://github.com/Arlieeee/claude-code)时发现的:它的 `BashTool`
走 `awaitClassifierAutoApproval` —— 用一个**分类器判断这条命令安不安全**,
批准来源分成 `hook` / `user` / `classifier` 三类,拒绝也分 `hook` / `user_abort` / `user_reject`,
子 agent 还有单独的拒绝文案。

本项目的 `bash.ts` 用的是正则黑名单,注释里已经承认"黑名单永远不完备,它的作用是挡误伤而非防攻击"。
分类器是更对的方向:`rm -rf $(cat /tmp/x)` 这种拼接出来的命令,正则永远追不上。

代价是每次 bash 调用多一次 LLM 往返。合理的折中是**分层**:白名单直接放行(`ls`/`cat`/`git status`)、
黑名单直接拒、剩下的灰区才问分类器。

**怎么量**:`constrain-01` 的 Security 门是现成的,加一批"看起来无害但实际越权"的命令即可 ——
正则会漏,分类器应该能拦。这题目前还没造。

### 5. bench 在长时高并发下会卡死(新增,优先级最高)

跑 HumanEval 时撞到两次:240 格的跑分停在中途不动,日志 mtime 三四分钟纹丝不变。

- 第一次卡在 `pi` 档 —— `agent.abort()` 断不掉底下的流式请求。已加 `Promise.race` 兜底。
- 第二次卡在 `react-min` 档 —— 它**本来就有** `withTimeout`,照样卡了 216 秒(超时设的 150 秒)。

说明问题不在某一档的超时实现,而在更底下:并发 6 + Python 子进程 + 流式 fetch 的某处会死锁,
`Promise.race` 只能让**等待**的那个 Promise 提前 reject,断不掉真正挂住的 I/O。

眼下的绕法是把并发降到 3。真正的修法是给每格套**进程级**隔离(worker_threads 或子进程),
超时直接 kill —— 评测框架不能指望被测代码优雅退出,这条在 `pi` 档上已经吃过一次亏了。

## 已知要还的债

- **多实例水平扩容**:bullmq 模式下 SSE chunk 由执行者进程的 bus 发出,多实例需要把转播搬到 Redis pub/sub。同 thread 串行锁与喊停的 abort 句柄也是进程内的,多实例时要换成 Redis 锁 + cancel pub/sub。
  现状是 gateway 与 worker 必须同进程、单实例。
- **沙箱只有路径级**:`workspace.ts` 挡得住 `../../etc/passwd`,挡不住 bash 里的 `cd /`。
  容器化已就绪(Dockerfile),但没有 per-thread 容器隔离。DeerFlow 在这块是容器/K8s 级。
- **增量 fold**:每轮 `load(threadId)` 全量重放。实测在当前任务规模下不是瓶颈
  (逐题耗时与极简循环持平),但事件上万后会是。等到量得出来再改。

## 评测本身要补的

- **模型覆盖**:目前只有 DeepSeek v4 系列。Harness-Bench 的核心结论是"模型越强 harness 差异越小",
  换到弱模型上差距应该拉开 —— 这是验证框架价值最直接的实验。
- **`hard-03` 规模不够**:号称大工作区,实测塞进提示词才 5.5k token,`raw` 轻松做完。
  要真正封死无工具基线,得做到 50k+ token 量级。
- **真实第三方框架**:已接入 Pi 的 agent loop([harness/pi.ts](packages/bench/src/harness/pi.ts))。
  DeerFlow 是 Python/LangGraph 栈,接进来需要跨语言 runner,暂列为待评估。
- ✅ **缓存命中进了成本模型**(2026-09-30):`Usage.cached_tokens` 读 DeepSeek 的 `prompt_cache_hit_tokens`,
  报告按命中价 / 未命中价分开算,并新增缓存命中列。数据一接上就照出两个问题(前缀不稳定、无关技能占提示词),
  改完 `my-agent` 成本/题 flash −13%、pro −7%,见 [BENCHMARK 第三轮](./BENCHMARK.zh-CN.md)。
- ✅ **请求只追加**(第四轮):system 纯静态、环境快照进日志、摘要请求重放前缀。单题成本 −18%,会话成本 −13~16%,
  摘要调用命中 0% → 95%。第三轮说的"pro 上比 `react-min` 贵 28%"是未加盐时测的,加盐后 pro 上三档打平、flash 上最便宜。
- **离长会话 97%+ 的命中还有距离**:剩下的 miss 基本是新内容。要再往上,得让会话更长、每次新增更少 ——
  比如大工具输出落文件只留预览(下一条),而不是让它整段进上下文。
- **工具结果截断在 4000 字符**:省 token,但会丢信息(大文件、长日志)。更好的做法是超长结果落文件、上下文只留预览和路径。
  现有任务集太小量不出差别,要等上下文压力大的任务集(SWE-bench,见下)。
  (踩过的坑:Pi 的 `usage.input` **不含**缓存命中部分,而我们取的是含缓存的
  `prompt_tokens`。口径不对齐时曾得出"Pi 省 4.4 倍 token"的错误结论。)
