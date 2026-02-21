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
- Prisma ORM
- PostgreSQL
- Node.js 20.x

## Run locally

### 1) Install dependencies
```bash
pnpm install
```

### 2) Configure environment
Set these variables in `backend/.env`:

- `DATABASE_URL`: pooled connection used by Prisma Client at runtime.
- `DIRECT_URL`: direct connection used by Prisma Migrate.

Supabase example:
```bash
DATABASE_URL="postgresql://postgres.<project-ref>:<db-password>@aws-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require"
DIRECT_URL="postgresql://postgres.<project-ref>:<db-password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require"
```

Optional:
- `SEED_SAMPLE_DATA=false` to disable startup seed data.
- `TEST_DATABASE_URL` for e2e tests (falls back to `DATABASE_URL`).

### 3) Apply database migrations
```bash
pnpm run prisma:deploy
```

For local development you can also use:
```bash
pnpm run prisma:migrate
```

### 4) Start server (dev)
```bash
pnpm run start:dev
```

Server runs on:
- `http://localhost:3000` (default)
- Use `PORT` env var to change it.

### 5) Health check
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

Important:
- `DELETE /bom/links/:parentId/:childId` is a delete endpoint.
- Opening that URL in a browser sends `GET`, so it will not delete the link.

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
- Data is persisted in PostgreSQL.
- Seeded dataset is applied idempotently on startup when `SEED_SAMPLE_DATA` is not `false` (root part: `Autonomous Cart Assembly`).

## Useful scripts
- `pnpm run start` - run app
- `pnpm run start:dev` - run with watch mode
- `pnpm run build` - build TypeScript
- `pnpm run lint` - lint code
- `pnpm run test` - unit tests
- `pnpm run test:e2e` - end-to-end tests
- `pnpm run prisma:generate` - generate Prisma client
- `pnpm run prisma:migrate` - run Prisma dev migration flow
- `pnpm run prisma:deploy` - apply existing migrations
