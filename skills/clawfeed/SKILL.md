---
name: clawfeed
description: 使用 192.168.2.21 上的 ClawFeed 系统，管理信息源、生成摘要、推送内容。
---

# ClawFeed 系统使用指南

ClawFeed 部署在 `192.168.2.21:8767`，这是一个单用户本地部署的新闻聚合系统。你可以通过 API 与其交互，无需认证。

## 核心地址

- **API 端点**: `http://192.168.2.21:8767/api`
- **Web 界面**: `http://192.168.2.21:8767`

## 你能做什么

### 1. 查看订阅源

获取当前配置的所有信息源：

```bash
curl http://192.168.2.21:8767/api/sources
```

响应包含每个源的 ID、名称、类型（rss/twitter_feed 等）、配置和订阅状态。

### 2. 添加新信息源

```bash
curl -X POST http://192.168.2.21:8767/api/sources \
  -H "Content-Type: application/json" \
  -d '{
    "name": "源名称",
    "type": "rss",
    "config": {"url": "https://example.com/feed.xml"},
    "category": "分类名",
    "subcategory": "子分类"
  }'
```

支持的类型：`rss`, `twitter_feed`, `twitter_list`, `reddit`, `hackernews`, `github_trending`, `digest_feed`, `website`

### 3. 生成并推送摘要

**第一步：获取现有内容**

```bash
curl "http://192.168.2.21:8767/api/digests?type=4h&limit=5"
```

类型可选：`4h`, `daily`, `weekly`, `monthly`

**第二步：推送新摘要**

```bash
curl -X POST http://192.168.2.21:8767/api/digests \
  -H "Content-Type: application/json" \
  -d '{
    "type": "4h",
    "content": "## 今日热点\n\n- 新闻1: [标题](链接)\n- 新闻2: [标题](链接)"
  }'
```

### 4. 管理收藏 (Marks)

```bash
# 查看所有收藏
curl http://192.168.2.21:8767/api/marks

# 添加收藏
curl -X POST http://192.168.2.21:8767/api/marks \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/article"}'

# 删除收藏
curl -X DELETE http://192.168.2.21:8767/api/marks/123
```

### 5. 导出订阅源

```bash
curl http://192.168.2.21:8767/api/sources/export -o sources-backup.json
```

### 6. 自动识别 URL 类型

不确定源类型时，让系统帮你识别：

```bash
curl "http://192.168.2.21:8767/api/sources/resolve?url=https://twitter.com/username"
```

## 完整 API 列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/digests | 获取摘要列表 |
| GET | /api/digests/:id | 获取单条摘要 |
| POST | /api/digests | 创建新摘要 |
| GET | /api/sources | 获取所有源 |
| POST | /api/sources | 创建源 |
| PUT | /api/sources/:id | 更新源 |
| DELETE | /api/sources/:id | 删除源 |
| GET | /api/sources/export | 导出所有源 |
| GET | /api/sources/resolve | 识别 URL 类型 |
| GET | /api/marks | 获取收藏 |
| POST | /api/marks | 添加收藏 |
| DELETE | /api/marks/:id | 删除收藏 |
| GET | /api/subscriptions | 获取订阅 |
| PUT | /api/subscriptions/rename-group | 重命名分类 |

## 使用建议

1. **获取订阅列表** → 了解当前监控哪些源
2. **分析现有摘要风格** → 保持输出格式一致
3. **生成摘要** → 使用 Markdown 格式，包含清晰的标题和链接
4. **推送摘要** → 通过 POST /api/digests 落库
5. **验证结果** → 访问 Web 界面查看效果
