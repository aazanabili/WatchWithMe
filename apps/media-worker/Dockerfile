FROM node:20-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/media-worker/package.json apps/media-worker/package.json
COPY packages/database/package.json packages/database/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY apps/media-worker apps/media-worker
COPY packages/database packages/database
RUN packages/database/node_modules/.bin/prisma generate --schema packages/database/prisma/schema.prisma
RUN npm run build --workspace @watch-with-me/media-worker
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* && addgroup --system app && adduser --system --ingroup app app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/media-worker/dist ./apps/media-worker/dist
COPY --from=build /app/apps/media-worker/package.json ./apps/media-worker/package.json
USER app
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "process.kill(process.pid,0)"
CMD ["node","apps/media-worker/dist/index.js"]
