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
- In-memory data store (no database yet)

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
- Data is stored in memory.
- Data resets every time the backend restarts.
- Seeded dataset includes sample assembly tree (root part: `Autonomous Cart Assembly`).

## Useful scripts
- `pnpm run start` - run app
- `pnpm run start:dev` - run with watch mode
- `pnpm run build` - build TypeScript
- `pnpm run lint` - lint code
- `pnpm run test` - unit tests
- `pnpm run test:e2e` - end-to-end tests

## Quick explanation
"This backend is a lightweight BOM API built with NestJS. It manages parts, BOM relationships, and audit logs while enforcing core BOM rules such as no cycles and valid quantities. It uses in-memory seeded data, so it is easy to run and demo locally."
