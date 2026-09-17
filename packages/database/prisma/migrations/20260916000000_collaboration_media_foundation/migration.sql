-- Foundation only: chat remains ephemeral in Redis and has no table.
ALTER TYPE "MediaProvider" RENAME TO "MediaProvider_old";
CREATE TYPE "MediaProvider" AS ENUM ('youtube', 'upload', 'mp4', 'instagram', 'tiktok', 'vimeo', 'dailymotion', 'twitch', 'facebook');
ALTER TABLE "PlaybackSnapshot" ALTER COLUMN "provider" TYPE "MediaProvider" USING (CASE "provider"::text WHEN 'CUSTOM' THEN 'mp4' ELSE lower("provider"::text) END)::"MediaProvider";
DROP TYPE "MediaProvider_old";
CREATE TYPE "SyncMode" AS ENUM ('full', 'view_only');
CREATE TYPE "SubtitleFormat" AS ENUM ('vtt', 'srt');
CREATE TYPE "HostTransferPolicy" AS ENUM ('auto_transfer_oldest');
ALTER TABLE "Room" ADD COLUMN "hostTransferPolicy" "HostTransferPolicy" NOT NULL DEFAULT 'auto_transfer_oldest', ADD COLUMN "conferenceEnabled" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "conferenceMaxParticipants" INTEGER;
ALTER TABLE "Participant" ADD COLUMN "revokedAt" TIMESTAMP(3), ADD COLUMN "permissions" JSONB, ADD COLUMN "joinOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlaybackSnapshot" ADD COLUMN "durationSeconds" DOUBLE PRECISION, ADD COLUMN "syncMode" "SyncMode" NOT NULL DEFAULT 'full';
CREATE TABLE "MediaAsset" ("id" TEXT NOT NULL, "objectKey" TEXT NOT NULL, "contentType" TEXT NOT NULL, "sizeBytes" BIGINT NOT NULL, "durationSeconds" DOUBLE PRECISION, "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "roomId" TEXT, CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id"));
CREATE TABLE "SubtitleTrack" ("id" TEXT NOT NULL, "assetId" TEXT NOT NULL, "language" TEXT NOT NULL, "format" "SubtitleFormat" NOT NULL, "objectKey" TEXT NOT NULL, CONSTRAINT "SubtitleTrack_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "MediaAsset_objectKey_key" ON "MediaAsset"("objectKey");
CREATE INDEX "MediaAsset_expiresAt_idx" ON "MediaAsset"("expiresAt");
CREATE UNIQUE INDEX "SubtitleTrack_assetId_language_key" ON "SubtitleTrack"("assetId", "language");
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SubtitleTrack" ADD CONSTRAINT "SubtitleTrack_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
