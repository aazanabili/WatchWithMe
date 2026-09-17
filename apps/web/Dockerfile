FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/realtime/package.json apps/realtime/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN npm ci

FROM deps AS build
ARG REALTIME_INTERNAL_URL=http://realtime:4000
ARG NEXT_PUBLIC_LIVEKIT_URL=ws://localhost:7880
ARG NEXT_PUBLIC_LIVEKIT_RELAY_ONLY=true
ENV REALTIME_INTERNAL_URL=$REALTIME_INTERNAL_URL
ENV NEXT_PUBLIC_LIVEKIT_URL=$NEXT_PUBLIC_LIVEKIT_URL
ENV NEXT_PUBLIC_LIVEKIT_RELAY_ONLY=$NEXT_PUBLIC_LIVEKIT_RELAY_ONLY
COPY . .
RUN npm run build --workspace @watch-with-me/contracts && npm run build --workspace @watch-with-me/web

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV REALTIME_INTERNAL_URL=http://realtime:4000
ENV NEXT_PUBLIC_LIVEKIT_URL=ws://localhost:7880
ENV NEXT_PUBLIC_LIVEKIT_RELAY_ONLY=true
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /app/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
