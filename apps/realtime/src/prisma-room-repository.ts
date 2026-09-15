import { PrismaClient, type MediaProvider, type ParticipantRole } from '@watch-with-me/database';
import type { PlaybackSnapshot } from '@watch-with-me/contracts';
import type { Room } from './index';

/** Durable adapter. The realtime process owns no authoritative room state in memory. */
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
            role: (p.role === 'host' ? 'HOST' : 'GUEST') as ParticipantRole,
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
      playback: saved.playbackSnapshot ? this.toPlayback(saved.playbackSnapshot) : null,
      participants: new Map(
        saved.participants.map((p) => [
          p.id,
          {
            id: p.id,
            role: p.role.toLowerCase() as 'host' | 'viewer',
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

  async save(room: Room) {
    await this.db.$transaction(async (tx) => {
      await tx.room.update({ where: { id: room.code }, data: { sequence: room.sequence } });
      for (const p of room.participants.values())
        await tx.participant.upsert({
          where: { id: p.id },
          create: {
            id: p.id,
            roomId: room.code,
            displayName: p.displayName,
            role: (p.role === 'host' ? 'HOST' : 'GUEST') as ParticipantRole,
            tokenHash: p.tokenHash,
            online: p.online,
          },
          update: {
            displayName: p.displayName,
            role: (p.role === 'host' ? 'HOST' : 'GUEST') as ParticipantRole,
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
    });
  }

  private toPlayback(value: {
    provider: string;
    mediaId: string;
    positionMs: number;
    isPlaying: boolean;
    updatedAt: Date;
  }): PlaybackSnapshot {
    return {
      provider: value.provider as 'youtube' | 'mp4',
      videoId: value.mediaId,
      status: value.isPlaying ? 'playing' : 'paused',
      positionSeconds: value.positionMs / 1000,
      updatedAt: value.updatedAt.toISOString(),
    };
  }
  private fromPlayback(roomId: string, value: PlaybackSnapshot) {
    return {
      id: `snapshot-${roomId}`,
      roomId,
      provider: (value.provider === 'youtube' ? 'YOUTUBE' : 'CUSTOM') as MediaProvider,
      mediaId: value.videoId,
      positionMs: Math.round(value.positionSeconds * 1000),
      isPlaying: value.status === 'playing',
      version: 0,
      capturedAt: new Date(value.updatedAt),
    };
  }
}
