-- Initial PostgreSQL schema. Apply with `prisma migrate deploy`.

CREATE TABLE "Room" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "hostParticipantId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "Room_hostParticipantId_key" ON "Room"("hostParticipantId");
CREATE INDEX "Room_status_expiresAt_idx" ON "Room"("status", "expiresAt");
CREATE INDEX "Room_expiresAt_idx" ON "Room"("expiresAt");

CREATE TABLE "Participant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roomId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'GUEST',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "online" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "Participant_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Participant_roomId_id_key" ON "Participant"("roomId", "id");
CREATE INDEX "Participant_roomId_lastSeenAt_idx" ON "Participant"("roomId", "lastSeenAt");

CREATE TABLE "PlaybackSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roomId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "positionMs" INTEGER NOT NULL DEFAULT 0,
  "isPlaying" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 0,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlaybackSnapshot_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PlaybackSnapshot_roomId_key" ON "PlaybackSnapshot"("roomId");
CREATE INDEX "PlaybackSnapshot_roomId_version_idx" ON "PlaybackSnapshot"("roomId", "version");

CREATE TABLE "IdempotencyKey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roomId" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "responseStatus" INTEGER,
  "responseBody" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdempotencyKey_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IdempotencyKey_roomId_keyHash_key" ON "IdempotencyKey"("roomId", "keyHash");
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- Added after Participant exists to permit a nullable host during room creation.
CREATE INDEX "Room_hostParticipantId_idx" ON "Room"("hostParticipantId");
