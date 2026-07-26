# my-agent Bench — harness 对照评测报告

> 生成于 2026-07-26T07:45:39.040Z · 耗时 331s · 模型 `deepseek-v4-flash` · 预算 maxSteps=10 timeout=120s

方法论沿用 Harness-Bench(arXiv:2605.27922):**固定**任务提示、初始沙箱、预算、超时、评分器,**只变** harness。
三档 harness 共用同一个 provider 实现、同一套工具实现、同一个端点——分差因此可以归因到编排层。

## 被测配置

| harness | 说明 |
|---|---|
| `my-agent` | 完整 harness:事件溯源 + fold/decide + 投影清洗 + 瞬时故障重投 + 分场景提示词 + 工作区清单注入 + compaction。 |

## 总分

| harness | 模型 | Completion | TaskScore | Process | 越权 | LLM 调用/题 | 工具调用/题 | 工具报错/题 | 总 token | 成本 | 成本/题 | 平均耗时 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `my-agent` | deepseek-v4-flash | **97.5%** | 86.6% | 88.4% | 0 | 6.67 | 5.67 | 0.17 | 714,349 | $0.106 | $0.0026 | 20.2s |

- **Completion** = oracle 判定的客观完成度(主指标,答"做成了吗")
- **TaskScore** = Security × Completion × Process(答"做得体面吗";越权直接 0)
- **Process** = 错误恢复 / 预算效率 / 终态自洽 的均值,带 0.4 地板

> 「平均耗时」仅供参考:跑分是并发的,单格 wallMs 会被 API 排队放大(实测同一格串行 10s / 并发下偶发 130s)。
> 比较效率请看 LLM 调用数与 token,它们不受并发影响。

## harness 带来的增量(相对原生 API)

| 模型 | harness | Completion | 相对 raw | 相对提升 |
|---|---|---:|---:|---:|

## 分类得分(Completion)

| 能力维度 | `my-agent` |
|---|---:|
| software-engineering | 97.5% |

## 逐题得分(Completion)

| 题目 | 考点 | `my-agent` |
|---|---|---:|
| `humaneval-000` | HumanEval/0 · has_close_elements | 100.0% |
| `humaneval-001` | HumanEval/1 · separate_paren_groups | 100.0% |
| `humaneval-002` | HumanEval/2 · truncate_number | 100.0% |
| `humaneval-003` | HumanEval/3 · below_zero | 100.0% |
| `humaneval-004` | HumanEval/4 · mean_absolute_deviation | 100.0% |
| `humaneval-005` | HumanEval/5 · intersperse | 100.0% |
| `humaneval-006` | HumanEval/6 · parse_nested_parens | 100.0% |
| `humaneval-007` | HumanEval/7 · filter_by_substring | 100.0% |
| `humaneval-008` | HumanEval/8 · sum_product | 100.0% |
| `humaneval-009` | HumanEval/9 · rolling_max | 100.0% |
| `humaneval-010` | HumanEval/10 · make_palindrome | 100.0% |
| `humaneval-011` | HumanEval/11 · string_xor | 100.0% |
| `humaneval-012` | HumanEval/12 · longest | 100.0% |
| `humaneval-013` | HumanEval/13 · greatest_common_divisor | 100.0% |
| `humaneval-014` | HumanEval/14 · all_prefixes | 100.0% |
| `humaneval-015` | HumanEval/15 · string_sequence | 100.0% |
| `humaneval-016` | HumanEval/16 · count_distinct_characters | 100.0% |
| `humaneval-017` | HumanEval/17 · parse_music | 100.0% |
| `humaneval-018` | HumanEval/18 · how_many_times | 100.0% |
| `humaneval-019` | HumanEval/19 · sort_numbers | 100.0% |
| `humaneval-020` | HumanEval/20 · find_closest_elements | 100.0% |
| `humaneval-021` | HumanEval/21 · rescale_to_unit | 100.0% |
| `humaneval-022` | HumanEval/22 · filter_integers | 100.0% |
| `humaneval-023` | HumanEval/23 · strlen | 100.0% |
| `humaneval-024` | HumanEval/24 · largest_divisor | 100.0% |
| `humaneval-025` | HumanEval/25 · factorize | 100.0% |
| `humaneval-026` | HumanEval/26 · remove_duplicates | 100.0% |
| `humaneval-027` | HumanEval/27 · flip_case | 100.0% |
| `humaneval-028` | HumanEval/28 · concatenate | 100.0% |
| `humaneval-029` | HumanEval/29 · filter_by_prefix | 100.0% |
| `humaneval-030` | HumanEval/30 · get_positive | 100.0% |
| `humaneval-031` | HumanEval/31 · is_prime | 100.0% |
| `humaneval-032` | HumanEval/32 · find_zero | 0.0% |
| `humaneval-033` | HumanEval/33 · sort_third | 100.0% |
| `humaneval-034` | HumanEval/34 · unique | 100.0% |
| `humaneval-035` | HumanEval/35 · max_element | 100.0% |
| `humaneval-036` | HumanEval/36 · fizz_buzz | 100.0% |
| `humaneval-037` | HumanEval/37 · sort_even | 100.0% |
| `humaneval-038` | HumanEval/38 · decode_cyclic | 100.0% |
| `humaneval-039` | HumanEval/39 · prime_fib | 100.0% |

## 失败与异常明细

| harness | 题目 | # | Completion | 终止原因 | 判定依据 |
|---|---|---:|---:|---|---|
| `my-agent` | `humaneval-032` | 1 | 0.0% | stop | 官方测试未通过:    assert math.fabs(poly(coeffs, solution)) < 1e-4 \|            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ \| AssertionError |
