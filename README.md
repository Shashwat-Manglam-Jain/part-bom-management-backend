# Backend - Part BOM Management API

NestJS backend for managing parts, BOM links, and audit logs.

## What this backend does
- Provides REST APIs for parts and BOM.
- Prevents invalid BOM links (self-link, duplicate link, cycle).
- Tracks audit logs for part and BOM changes.
- Starts with seeded sample data for quick local demo.

## Tech stack
- NestJS 11
- TypeScript
- SQLite (`better-sqlite3`)
- Node.js 20.x

## Run locally

### 1) Install dependencies
```bash
pnpm install
```

### 2) Start server (dev)
```bash
pnpm run start:dev
```

Server runs on:
- `http://localhost:3000` (default)
- Use `PORT` env var to change it.

Database settings:
- `DATABASE_PATH` (optional): SQLite file path
  - Local default: `./data/part-bom.sqlite`
  - Vercel default: `/tmp/part-bom.sqlite`
  - On Vercel, non-`/tmp` paths are ignored and fallback to `/tmp/part-bom.sqlite`
- `SEED_SAMPLE_DATA` (optional): set `false` to disable startup seed

### 3) Health check
```http
GET /health
```
Response:
```json
{
  "status": "ok",
  "service": "part-bom-management"
}
```

## API overview

### Parts
- `GET /parts?q=searchText`
- `GET /parts?partNumber=PRT-000001`
- `GET /parts?name=controller`
- `POST /parts`
- `PUT /parts/:partId`
- `GET /parts/:partId`
- `GET /parts/:partId/audit-logs`

Create part payload:
```json
{
  "name": "Motor Controller",
  "partNumber": "PRT-009999",
  "description": "Optional description"
}
```

### BOM
- `GET /bom/:rootPartId?depth=1&nodeLimit=80`
- `POST /bom/links`
- `PUT /bom/links`
- `DELETE /bom/links/:parentId/:childId`

Create BOM link payload:
```json
{
  "parentId": "PART-0001",
  "childId": "PART-0002",
  "quantity": 2
}
```

Update BOM link payload:
```json
{
  "parentId": "PART-0001",
  "childId": "PART-0002",
  "quantity": 5
}
```

## Rules and limits
- Part name is required.
- Part number (if sent) must be unique.
- Auto-generated part numbers use format: `PRT-000001`.
- BOM quantity must be a positive integer.
- BOM cannot link a part to itself.
- BOM cannot create cycles.
- Max BOM expansion depth: `5`
- Max BOM node limit: `80`

## Data behavior
- Data is persisted in SQLite.
- Default DB file: `backend/data/part-bom.sqlite`.
- Seeded dataset is inserted only when DB is empty (root part: `Autonomous Cart Assembly`).
- On Vercel, SQLite file is stored in `/tmp`, so data is ephemeral per serverless instance.

## Deploy to Vercel (backend)
1. Import this repo in Vercel.
2. Set project **Root Directory** to `backend`.
3. Keep build command default (`pnpm run build`).
4. Set Node.js version to `20.x` in Vercel project settings.
5. Add environment variables:
   - `SEED_SAMPLE_DATA=true` (or `false` if you do not want seed data)
   - `DATABASE_PATH=/tmp/part-bom.sqlite` (recommended on Vercel)
6. Deploy.

Notes:
- Vercel serverless filesystem is ephemeral. SQLite data will not be permanently stored.
- For permanent production data, use a managed database (PostgreSQL/MySQL).

## Useful scripts
- `pnpm run start` - run app
- `pnpm run start:dev` - run with watch mode
- `pnpm run build` - build TypeScript
- `pnpm run lint` - lint code
- `pnpm run test` - unit tests
- `pnpm run test:e2e` - end-to-end tests

## Quick explanation
"This backend is a lightweight BOM API built with NestJS. It manages parts, BOM relationships, and audit logs while enforcing core BOM rules such as no cycles and valid quantities. Data is persisted in SQLite with optional startup seed data."
