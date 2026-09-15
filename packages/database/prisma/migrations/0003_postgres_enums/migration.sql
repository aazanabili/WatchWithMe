CREATE TYPE "RoomStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CLOSED');
CREATE TYPE "ParticipantRole" AS ENUM ('HOST', 'GUEST');
CREATE TYPE "MediaProvider" AS ENUM ('YOUTUBE', 'VIMEO', 'CUSTOM');
ALTER TABLE "Room" ALTER COLUMN "status" DROP DEFAULT, ALTER COLUMN "status" TYPE "RoomStatus" USING "status"::"RoomStatus", ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
ALTER TABLE "Participant" ALTER COLUMN "role" DROP DEFAULT, ALTER COLUMN "role" TYPE "ParticipantRole" USING "role"::"ParticipantRole", ALTER COLUMN "role" SET DEFAULT 'GUEST';
ALTER TABLE "PlaybackSnapshot" ALTER COLUMN "provider" TYPE "MediaProvider" USING "provider"::"MediaProvider";
