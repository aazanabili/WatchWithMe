import { PrismaClient, type MediaProvider, type ParticipantRole } from '@watch-with-me/database';
type PrismaSyncMode = 'FULL' | 'VIEW_ONLY';
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

export type DomainMediaProvider =
  | 'youtube'
  | 'upload'
  | 'mp4'
  | 'instagram'
  | 'tiktok'
  | 'vimeo'
  | 'dailymotion'
  | 'twitch'
  | 'facebook';

const mediaProviderToDomain = {
  YOUTUBE: 'youtube',
  UPLOAD: 'upload',
  MP4: 'mp4',
  INSTAGRAM: 'instagram',
  TIKTOK: 'tiktok',
  VIMEO: 'vimeo',
  DAILYMOTION: 'dailymotion',
  TWITCH: 'twitch',
  FACEBOOK: 'facebook',
} as const satisfies Record<MediaProvider, DomainMediaProvider>;

const domainProviderToMedia = {
  youtube: 'YOUTUBE',
  upload: 'UPLOAD',
  mp4: 'MP4',
  instagram: 'INSTAGRAM',
  tiktok: 'TIKTOK',
  vimeo: 'VIMEO',
  dailymotion: 'DAILYMOTION',
  twitch: 'TWITCH',
  facebook: 'FACEBOOK',
} as const satisfies Record<DomainMediaProvider, MediaProvider>;

/** Translate the supported persistence providers explicitly; CUSTOM is the MP4 provider in Prisma. */
export function mapMediaProvider(provider: MediaProvider | 'CUSTOM'): DomainMediaProvider;
/** Legacy database rows used CUSTOM for MP4; retain read compatibility during migration. */
export function mapMediaProvider(provider: 'CUSTOM'): DomainMediaProvider;
export function mapMediaProvider(provider: DomainMediaProvider): MediaProvider;
export function mapMediaProvider(
  provider: MediaProvider | DomainMediaProvider | 'CUSTOM',
): MediaProvider | DomainMediaProvider {
  if (provider === 'CUSTOM') return 'mp4';
  if (provider in mediaProviderToDomain) return mediaProviderToDomain[provider as MediaProvider];
  if (provider in domainProviderToMedia)
    return domainProviderToMedia[provider as DomainMediaProvider];
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
          expiresAt: new Date(Date.now() + 3 * 3600_000),
          sequence: room.sequence,
          conferenceEnabled: room.conferenceEnabled ?? false,
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
      status: saved.status,
      expiresAt: saved.expiresAt.toISOString(),
      sequence: saved.sequence,
      revision: saved.revision,
      conferenceEnabled: saved.conferenceEnabled,
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
            revokedAt: p.revokedAt?.toISOString(),
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
        data: {
          sequence: room.sequence,
          revision: room.revision,
          status: room.status ?? 'ACTIVE',
          expiresAt: room.expiresAt ? new Date(room.expiresAt) : undefined,
          conferenceEnabled: room.conferenceEnabled,
        },
      });
      if (claimed.count !== 1) return false;
      // Mirror removals (kick) durably; upsert-only persistence resurrected kicked
      // capabilities on the next request when the room was reloaded from PostgreSQL.
      await tx.participant.deleteMany({
        where: { roomId: room.code, id: { notIn: [...room.participants.keys()] } },
      });
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
            revokedAt: p.revokedAt ? new Date(p.revokedAt) : null,
          },
          update: {
            displayName: p.displayName,
            role: mapParticipantRole(p.role),
            online: p.online,
            lastSeenAt: new Date(),
            revokedAt: p.revokedAt ? new Date(p.revokedAt) : null,
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
            durationSeconds: snapshot.durationSeconds,
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
            expiresAt: new Date(Date.now() + 3 * 3600_000),
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
    durationSeconds?: number | null;
    syncMode?: 'FULL' | 'VIEW_ONLY';
  }): PlaybackSnapshot {
    const provider = mapMediaProvider(value.provider);
    return {
      provider,
      videoId: value.mediaId,
      status: value.isPlaying ? 'playing' : 'paused',
      positionSeconds: value.positionMs / 1000,
      updatedAt: value.updatedAt.toISOString(),
      revision: value.revision,
      durationSeconds: value.durationSeconds ?? null,
      syncMode: value.syncMode === 'VIEW_ONLY' ? 'view_only' : undefined,
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
      durationSeconds: value.durationSeconds,
      syncMode: (value.syncMode === 'view_only' ? 'VIEW_ONLY' : 'FULL') as PrismaSyncMode,
    };
  }
}
