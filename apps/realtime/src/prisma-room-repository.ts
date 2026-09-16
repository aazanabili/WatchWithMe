import { PrismaClient, type MediaProvider, type ParticipantRole } from '@watch-with-me/database';
import type { PlaybackSnapshot } from '@watch-with-me/contracts';
import type { Room } from './index';

export type DomainParticipantRole = 'host' | 'viewer';

const participantRoleToDomain = {
  HOST: 'host',
  GUEST: 'viewer',
} as const satisfies Record<ParticipantRole, DomainParticipantRole>;

const domainRoleToParticipant = {
  host: 'HOST',
  viewer: 'GUEST',
} as const satisfies Record<DomainParticipantRole, ParticipantRole>;

/** Translate the persistence enum and domain role without relying on casing. */
export function mapParticipantRole(role: ParticipantRole): DomainParticipantRole;
export function mapParticipantRole(role: DomainParticipantRole): ParticipantRole;
export function mapParticipantRole(
  role: ParticipantRole | DomainParticipantRole,
): ParticipantRole | DomainParticipantRole {
  if (role === 'HOST' || role === 'GUEST') return participantRoleToDomain[role];
  if (role === 'host' || role === 'viewer') return domainRoleToParticipant[role];
  throw new Error(`Unsupported participant role: ${role}`);
}

export type DomainMediaProvider = 'youtube' | 'mp4';

const mediaProviderToDomain = {
  YOUTUBE: 'youtube',
  CUSTOM: 'mp4',
} as const satisfies Record<'YOUTUBE' | 'CUSTOM', DomainMediaProvider>;

const domainProviderToMedia = {
  youtube: 'YOUTUBE',
  mp4: 'CUSTOM',
} as const satisfies Record<DomainMediaProvider, 'YOUTUBE' | 'CUSTOM'>;

/** Translate the supported persistence providers explicitly; CUSTOM is the MP4 provider in Prisma. */
export function mapMediaProvider(provider: MediaProvider): DomainMediaProvider;
export function mapMediaProvider(provider: DomainMediaProvider): MediaProvider;
export function mapMediaProvider(
  provider: MediaProvider | DomainMediaProvider,
): MediaProvider | DomainMediaProvider {
  if (provider === 'YOUTUBE' || provider === 'CUSTOM') return mediaProviderToDomain[provider];
  if (provider === 'youtube' || provider === 'mp4') return domainProviderToMedia[provider];
  throw new Error(`Unsupported media provider: ${provider}`);
}

/** Durable adapter. A process-local coordinator serializes commands; PostgreSQL rejects stale saves. */
export class PrismaRoomRepository {
  constructor(private readonly db: PrismaClient = new PrismaClient()) {}

  async create(room: Room) {
    const host = [...room.participants.values()][0];
    await this.db.$transaction(async (tx) => {
      await tx.room.create({
        data: {
          id: room.code,
          expiresAt: new Date(Date.now() + 24 * 3600_000),
          sequence: room.sequence,
        },
      });
      for (const p of room.participants.values())
        await tx.participant.create({
          data: {
            id: p.id,
            roomId: room.code,
            displayName: p.displayName,
            role: mapParticipantRole(p.role),
            tokenHash: p.tokenHash,
            online: p.online,
          },
        });
      if (host)
        await tx.room.update({ where: { id: room.code }, data: { hostParticipantId: host.id } });
    });
  }

  async get(code: string) {
    const saved = await this.db.room.findUnique({
      where: { id: code },
      include: { participants: true, playbackSnapshot: true, idempotencyKeys: true },
    });
    if (!saved) return undefined;
    return {
      code: saved.id,
      sequence: saved.sequence,
      revision: saved.revision,
      playback: saved.playbackSnapshot ? this.toPlayback(saved.playbackSnapshot) : null,
      participants: new Map(
        saved.participants.map((p) => [
          p.id,
          {
            id: p.id,
            role: mapParticipantRole(p.role),
            displayName: p.displayName,
            tokenHash: p.tokenHash,
            online: p.online,
          },
        ]),
      ),
      commands: new Map(
        saved.idempotencyKeys
          .filter((k) => k.responseBody !== null)
          .map((k) => [k.responseBody!, k.responseStatus ?? 0]),
      ),
    };
  }

  async save(room: Room, expectedSequence = room.sequence): Promise<boolean> {
    const result = await this.db.$transaction(async (tx) => {
      const claimed = await tx.room.updateMany({
        where: { id: room.code, sequence: expectedSequence, revision: { lte: room.revision } },
        data: { sequence: room.sequence, revision: room.revision },
      });
      if (claimed.count !== 1) return false;
      for (const p of room.participants.values())
        await tx.participant.upsert({
          where: { id: p.id },
          create: {
            id: p.id,
            roomId: room.code,
            displayName: p.displayName,
            role: mapParticipantRole(p.role),
            tokenHash: p.tokenHash,
            online: p.online,
          },
          update: {
            displayName: p.displayName,
            role: mapParticipantRole(p.role),
            online: p.online,
            lastSeenAt: new Date(),
          },
        });
      if (room.playback) {
        const snapshot = this.fromPlayback(room.code, room.playback);
        await tx.playbackSnapshot.upsert({
          where: { roomId: room.code },
          create: snapshot,
          update: {
            provider: snapshot.provider,
            mediaId: snapshot.mediaId,
            positionMs: snapshot.positionMs,
            isPlaying: snapshot.isPlaying,
            capturedAt: snapshot.capturedAt,
            revision: snapshot.revision,
          },
        });
      }
      for (const [commandId, sequence] of room.commands)
        await tx.idempotencyKey.upsert({
          where: { roomId_keyHash: { roomId: room.code, keyHash: `command:${commandId}` } },
          create: {
            id: `cmd-${commandId}`,
            roomId: room.code,
            keyHash: `command:${commandId}`,
            responseBody: commandId,
            responseStatus: sequence,
            expiresAt: new Date(Date.now() + 24 * 3600_000),
          },
          update: { responseStatus: sequence },
        });
      return true;
    });
    return result;
  }

  private toPlayback(value: {
    provider: MediaProvider;
    mediaId: string;
    positionMs: number;
    isPlaying: boolean;
    updatedAt: Date;
    revision: number;
  }): PlaybackSnapshot {
    return {
      provider: mapMediaProvider(value.provider),
      videoId: value.mediaId,
      status: value.isPlaying ? 'playing' : 'paused',
      positionSeconds: value.positionMs / 1000,
      updatedAt: value.updatedAt.toISOString(),
      revision: value.revision,
    };
  }
  private fromPlayback(roomId: string, value: PlaybackSnapshot) {
    return {
      id: `snapshot-${roomId}`,
      roomId,
      provider: mapMediaProvider(value.provider),
      mediaId: value.videoId,
      positionMs: Math.round(value.positionSeconds * 1000),
      isPlaying: value.status === 'playing',
      version: value.revision,
      capturedAt: new Date(value.updatedAt),
      revision: value.revision,
    };
  }
}
