import type {
  PrismaClient,
  Room,
  Participant,
  PlaybackSnapshot,
  IdempotencyKey,
} from '@prisma/client';
import { hashSecret } from './hashing';

export const ROOM_STATUS = { ACTIVE: 'ACTIVE', EXPIRED: 'EXPIRED', CLOSED: 'CLOSED' } as const;
export const PARTICIPANT_ROLE = { HOST: 'HOST', GUEST: 'GUEST' } as const;
export const MEDIA_PROVIDER = { YOUTUBE: 'YOUTUBE', VIMEO: 'VIMEO', CUSTOM: 'CUSTOM' } as const;
export type RoomStatus = (typeof ROOM_STATUS)[keyof typeof ROOM_STATUS];
export type ParticipantRole = (typeof PARTICIPANT_ROLE)[keyof typeof PARTICIPANT_ROLE];
export type MediaProvider = (typeof MEDIA_PROVIDER)[keyof typeof MEDIA_PROVIDER];

export class RoomRepository {
  constructor(private readonly db: PrismaClient) {}

  createRoom(input: { id: string; expiresAt: Date; hostParticipantId?: string }): Promise<Room> {
    if (!input.id.trim() || !Number.isFinite(input.expiresAt.getTime()))
      throw new Error('Invalid room input');
    return this.db.room.create({
      data: {
        id: input.id,
        expiresAt: input.expiresAt,
        hostParticipantId: input.hostParticipantId,
      },
    });
  }
  getRoom(id: string): Promise<Room | null> {
    return this.db.room.findUnique({ where: { id } });
  }
  joinParticipant(input: {
    id: string;
    roomId: string;
    displayName: string;
    role?: ParticipantRole;
    token: string;
  }): Promise<Participant> {
    if (!input.id.trim() || !input.roomId.trim() || !input.displayName.trim() || !input.token) {
      throw new Error('Invalid participant input');
    }
    return this.db.participant.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        roomId: input.roomId,
        displayName: input.displayName,
        role: input.role ?? PARTICIPANT_ROLE.GUEST,
        tokenHash: hashSecret(input.token),
      },
      update: {
        displayName: input.displayName,
        lastSeenAt: new Date(),
        role: input.role,
        tokenHash: hashSecret(input.token),
      },
    });
  }
  saveSnapshot(
    input: Omit<PlaybackSnapshot, 'createdAt' | 'updatedAt'>,
  ): Promise<PlaybackSnapshot> {
    return this.db.playbackSnapshot.upsert({
      where: { roomId: input.roomId },
      create: input,
      update: {
        provider: input.provider,
        mediaId: input.mediaId,
        positionMs: input.positionMs,
        isPlaying: input.isPlaying,
        version: input.version,
        capturedAt: input.capturedAt,
      },
    });
  }
  getSnapshot(roomId: string): Promise<PlaybackSnapshot | null> {
    return this.db.playbackSnapshot.findUnique({ where: { roomId } });
  }
  async claimIdempotency(input: {
    id: string;
    roomId: string;
    key: string;
    expiresAt: Date;
  }): Promise<{ claimed: boolean; record: IdempotencyKey }> {
    if (
      !input.id.trim() ||
      !input.roomId.trim() ||
      !input.key ||
      !Number.isFinite(input.expiresAt.getTime())
    ) {
      throw new Error('Invalid idempotency input');
    }
    const keyHash = hashSecret(input.key);
    try {
      return {
        claimed: true,
        record: await this.db.idempotencyKey.create({
          data: { id: input.id, roomId: input.roomId, keyHash, expiresAt: input.expiresAt },
        }),
      };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error as { code?: string }).code !== 'P2002'
      )
        throw error;
      const record = await this.db.idempotencyKey.findUniqueOrThrow({
        where: { roomId_keyHash: { roomId: input.roomId, keyHash } },
      });
      if (record.expiresAt > new Date()) return { claimed: false, record };
      const reclaimed = await this.db.idempotencyKey.update({
        where: { id: record.id },
        data: {
          id: input.id,
          expiresAt: input.expiresAt,
          responseStatus: null,
          responseBody: null,
        },
      });
      return { claimed: true, record: reclaimed };
    }
  }
  expireRooms(now = new Date()): Promise<{ count: number }> {
    return this.db.room.updateMany({
      where: { expiresAt: { lte: now }, status: ROOM_STATUS.ACTIVE },
      data: { status: ROOM_STATUS.EXPIRED },
    });
  }
}
