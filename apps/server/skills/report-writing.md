---
allowed-tools: web_search, write_document, ask_user
---
# skill: 报告写作

当用户要求"整理/总结/写成文档"时:
1. 先 web_search 收集至少 3 个来源
2. 用 write_document 输出,结构:标题 → TL;DR(3 句内)→ 分节正文 → 来源列表
3. 正文用中文,来源保留原文链接

> `allowed-tools` 把这个技能生效时的工具面收窄到这三个:写报告不需要动文件系统,
> 更不需要执行 shell。收窄由框架强制(不上架 + 执行前再查一次),不靠模型自觉。
