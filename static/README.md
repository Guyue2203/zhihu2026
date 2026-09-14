# 离线策展数据

静态演示不在访客请求时搜索。构建流程是：

1. 在外部浏览器使用 `site:zhihu.com/question ...`、自定义日期区间等严格条件检索，每个阶段把结果页另存为 HTML。
2. 人工核验候选帖子的标题、答主、发布时间、赞同/评论数和立场，写入一个 manifest。
3. 运行 `node offline-pool.mjs manifest.json`。程序只接纳同时满足以下条件的帖子：出现在已保存的外部搜索页、是规范知乎回答链接、`verified: true`、发布时间位于阶段边界、内容与阶段相关。
4. 结果写入 `static/journeys/<slug>.json`；推荐分由相关度 55%、热度 30%、外部搜索排名 15% 组成，并优先保留不同立场。

最小 manifest 结构：

```json
{
  "slug": "bike",
  "query": "共享单车为什么失败",
  "title": "共享单车认知转变史",
  "thesis": "规模叙事如何被运营与现金证据改写",
  "limitPerStage": 3,
  "stages": [{
    "id": "stage-1",
    "period": "2015—2016",
    "from": "2015-01-01",
    "to": "2016-12-31",
    "title": "规模故事形成",
    "cognition": "当时的主流认识",
    "change": "相对上一阶段发生了什么变化",
    "evidence": "这一判断依据什么",
    "importance": "core",
    "keywords": ["共享单车", "融资"],
    "captures": ["captures/bike-2016.html"]
  }],
  "posts": [{
    "url": "知乎回答的完整链接",
    "question": "原问题标题",
    "answerer": "答主",
    "excerpt": "原回答短摘要",
    "viewpoint": "该回答代表的认知",
    "publishedAt": "2016-06-01",
    "votes": 0,
    "comments": 0,
    "stance": "positive",
    "verified": true
  }]
}
```

路径相对 manifest 所在目录；生成文件默认相对运行命令时的项目根目录。构建器在任一阶段没有合格帖子时直接失败，不会生成看似完整的假时间线。
