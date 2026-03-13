---
name: clawfeed
description: 使用 ClawFeed 系统管理信息源、写入新闻条目（items）、生成摘要与查看结果。
---

# ClawFeed 系统使用指南

ClawFeed 部署在 `192.168.2.21:8767`，是一个单用户新闻聚合系统。智能体主要负责抓取并提交新闻条目（items），系统负责存储与展示。

## 核心地址

- **API 端点**: `http://192.168.2.21:8767/api`
- **Web 界面**: `http://192.168.2.21:8767`

## 智能体推荐流程（写入 items）

1. **解析或创建信息源**
2. **抓取内容并结构化为 items**
3. **批量写入 items**
4. **按需生成摘要（可选）**
5. **用 Web 或 API 验证展示**

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

### 3. 写入新闻条目（items）

按源批量写入（推荐）：

```bash
curl -X POST http://192.168.2.21:8767/api/sources/<source_id>/items \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {
        "url": "https://example.com/news/1",
        "title": "标题",
        "summary": "摘要",
        "tags": ["ai","demo"],
        "published_at": "2026-03-13T08:00:00Z"
      }
    ]
  }'
```

跨源批量写入：

```bash
curl -X POST http://192.168.2.21:8767/api/items/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {
        "source_id": 1,
        "url": "https://example.com/news/2",
        "title": "标题2",
        "summary": "摘要2"
      }
    ]
  }'
```

### 4. 查询 items

```bash
curl "http://192.168.2.21:8767/api/items?limit=20&offset=0"
curl "http://192.168.2.21:8767/api/sources/<source_id>/items?limit=20"
```

### 5. 生成并推送摘要（可选）

**第一步：获取现有内容**

```bash
curl "http://192.168.2.21:8767/api/digests?type=4h&limit=20"
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

### 6. 导出订阅源

```bash
curl http://192.168.2.21:8767/api/sources/export -o sources-backup.json
```

### 7. 自动识别 URL 类型

不确定源类型时，让系统帮你识别：

```bash
curl -X POST http://192.168.2.21:8767/api/sources/resolve \
  -H "Content-Type: application/json" \
  -d '{"url":"https://twitter.com/username"}'
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
| POST | /api/sources/resolve | 识别 URL 类型 |
| POST | /api/sources/:id/items | 按源批量写入 items |
| POST | /api/items/bulk | 跨源批量写入 items |
| GET | /api/items | 查询 items |
| GET | /api/sources/:id/items | 按源查询 items |
| GET | /api/marks | 获取收藏 |
| POST | /api/marks | 添加收藏 |
| DELETE | /api/marks/:id | 删除收藏 |
| GET | /api/subscriptions | 获取订阅 |
| PUT | /api/subscriptions/rename-group | 重命名分类 |

## 使用建议

1. **优先写入 items** → 这是系统的核心数据层
2. **按需生成摘要** → items 聚合后再写摘要
3. **重复写入无副作用** → 系统按源+URL 去重
4. **验证结果** → 使用 `/api/items` 与 Web 界面检查
