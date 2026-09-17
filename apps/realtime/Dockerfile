FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/realtime/package.json apps/realtime/package.json
COPY apps/media-worker/package.json apps/media-worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN packages/database/node_modules/.bin/prisma generate --schema packages/database/prisma/schema.prisma && npm run build --workspace @watch-with-me/contracts && npm run build --workspace @watch-with-me/database && npm run build --workspace @watch-with-me/realtime
RUN npm prune --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=build --chown=app:app /app/apps/realtime/node_modules ./apps/realtime/node_modules
COPY --from=build --chown=app:app /app/apps/realtime/dist ./apps/realtime/dist
COPY --from=build --chown=app:app /app/packages/database ./packages/database
COPY --from=build --chown=app:app /app/packages/contracts ./packages/contracts
USER app
EXPOSE 4000
CMD ["node", "apps/realtime/dist/index.js"]
