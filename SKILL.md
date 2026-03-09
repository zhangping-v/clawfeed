# ClawFeed

AI-powered news digest tool for single-user local deployment. Automatically generates structured summaries (4H/daily/weekly/monthly) from Twitter and RSS feeds.

## Overview

ClawFeed is optimized for local network deployment (e.g., at `192.168.2.21`). It runs as a standalone service with no external authentication requirements — all features are available without login.

## Dependencies

| Dependency | Purpose | Required |
|-----------|---------|----------|
| `API_KEY` | Digest creation endpoint protection | Optional |

**Runtime dependency:** SQLite via `better-sqlite3` (native addon, bundled). No external database server required.

## Setup

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Edit .env with your settings

# Start API server
npm start
```

## Environment Variables

Configure in `.env` file:

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `DIGEST_PORT` | Server port | No | 8767 |
| `API_KEY` | Digest creation API key | No | - |
| `AI_DIGEST_DB` | SQLite database path | No | `data/digest.db` |
| `ALLOWED_ORIGINS` | CORS allowed origins | No | localhost |

## API Server

Runs on port `8767` by default. Set `DIGEST_PORT` env to change.

### Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | /api/digests | List digests (?type=4h\|daily\|weekly&limit=20&offset=0) | No |
| GET | /api/digests/:id | Get single digest | No |
| POST | /api/digests | Create digest (internal) | No |
| GET | /api/marks | List user bookmarks | No |
| POST | /api/marks | Add bookmark | No |
| DELETE | /api/marks/:id | Remove bookmark | No |
| GET | /api/sources | List sources | No |
| POST | /api/sources | Create source | No |
| PUT | /api/sources/:id | Update source | No |
| DELETE | /api/sources/:id | Delete source | No |
| GET | /api/sources/export | Export all sources as JSON | No |
| GET | /api/sources/resolve | Auto-detect source type from URL | No |
| GET | /api/subscriptions | List subscriptions | No |
| POST | /api/subscriptions | Subscribe to source | No |
| DELETE | /api/subscriptions/:id | Unsubscribe from source | No |
| PUT | /api/subscriptions/rename-group | Rename category/subcategory | No |
| GET | /api/config | Get configuration | No |
| PUT | /api/config | Update configuration | No |
| GET | /api/changelog | Get changelog | No |
| GET | /api/roadmap | Get roadmap | No |

## Web Dashboard

Open `http://localhost:8767` (or your configured host) to access the web dashboard. No login required.

## Templates

- `templates/curation-rules.md` — Customize feed curation rules
- `templates/digest-prompt.md` — Customize the AI summarization prompt

## Configuration

Copy `config.example.json` to `config.json` and edit. See README for details.

## Reverse Proxy (Caddy example)

```
digest.example.com {
    reverse_proxy localhost:8767
}
```

## Remote Management

This instance is optimized for local network deployment. For automated updates and cross-server agent collaboration, see the standardized skill at `_agents/skills/clawfeed-updater/SKILL.md`.
