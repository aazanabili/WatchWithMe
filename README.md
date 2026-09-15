# Watch With Me

Node 20+ TypeScript monorepo for synchronized watch rooms. PostgreSQL is the durable
source of truth; Redis is reserved for live state/presence. The in-memory repository
is enabled only by tests or `REALTIME_ROOM_REPOSITORY=in-memory`.

## Local development

```bash
cp .env.example .env       # PowerShell: Copy-Item .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate     # PostgreSQL must be running
npm run dev                # web :3000, realtime :4000
```

Start the database and Redis locally, or use Docker for all dependencies:

```bash
docker compose up --build
```

PostgreSQL and Redis are on an internal Docker network and have no published ports;
the web and realtime HTTP endpoints are published on 3000 and 4000.

## MVP smoke path

Open `/create`, enter a display name, and submit. Keep the returned room code/token,
then open `/join`, enter the code and another name. The room state endpoint is
`GET /api/rooms/:code/state`; Socket.IO connects to realtime for playback commands.

## Quality commands

```bash
npm run lint && npm run typecheck && npm test && npm run build
npx vitest run tests/security/realtime.security.test.ts
npm run test:e2e
npm run prisma:generate && npm run prisma:migrate
docker compose config
docker compose build && docker compose up -d
docker compose ps
docker compose down
```

`npm audit` is also part of release review. The remaining advisories are in the
development toolchain (Vitest/Vite/esbuild) or Prisma tooling; the available
remediations require breaking major upgrades, so `npm audit fix --force` is not
used automatically.

## MVP limitations

- Authentication is bearer-token based and intentionally minimal; no accounts or refresh tokens.
- Media is not proxied or downloaded; only validated YouTube IDs/HTTPS MP4 URLs are accepted.
- Redis live-state integration is available as a package primitive; room persistence is PostgreSQL.
- No production TLS, clustering/fan-out, moderation, durable event history, or media catalog yet.
