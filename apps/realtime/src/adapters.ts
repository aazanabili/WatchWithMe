import Redis from 'ioredis';
import { Client as MinioClient } from 'minio';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { ConferenceGrant, ConferenceTokenSigner } from './services/conference';
import type { KeyValueStore, ObjectStore } from './services/collaboration';
import { PrismaClient } from '@watch-with-me/database';

/** Production Redis adapter. Tests should inject InMemoryKeyValueStore instead. */
export class RedisKeyValueStore implements KeyValueStore {
  constructor(
    private readonly client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
  ) {}
  get(key: string) {
    return this.client.get(key);
  }
  set(key: string, value: string, mode: 'EX', ttl: number) {
    return this.client.set(key, value, mode, ttl);
  }
  del(key: string) {
    return this.client.del(key);
  }
  lpush(key: string, value: string) {
    return this.client.lpush(key, value);
  }
  lrange(key: string, start: number, stop: number) {
    return this.client.lrange(key, start, stop);
  }
  expire(key: string, ttl: number) {
    return this.client.expire(key, ttl);
  }
  async ready() {
    return (await this.client.ping()) === 'PONG';
  }
}

/** MinIO presigning is kept behind the ObjectStore port to prevent URL construction in routes. */
export class MinioObjectStore implements ObjectStore {
  private readonly bucket = process.env.MINIO_BUCKET ?? 'media';
  private readonly signingClient: MinioClient;
  private readonly publicOrigin = new URL(
    process.env.MINIO_PUBLIC_ORIGIN ?? 'http://localhost:9000',
  );
  constructor(
    private readonly client = new MinioClient({
      endPoint:
        process.env.MINIO_ENDPOINT ??
        (process.env.NODE_ENV === 'production'
          ? (() => {
              throw new Error('MINIO_ENDPOINT is required');
            })()
          : 'localhost'),
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey:
        process.env.MINIO_ACCESS_KEY ??
        (process.env.NODE_ENV === 'production'
          ? (() => {
              throw new Error('MINIO_ACCESS_KEY is required');
            })()
          : 'minioadmin'),
      secretKey:
        process.env.MINIO_SECRET_KEY ??
        (process.env.NODE_ENV === 'production'
          ? (() => {
              throw new Error('MINIO_SECRET_KEY is required');
            })()
          : 'minioadmin'),
    }),
  ) {
    // Health and object operations use the container-only endpoint; browser URLs
    // must be signed against the host-published endpoint so their Host header matches.
    this.signingClient = new MinioClient({
      endPoint: this.publicOrigin.hostname,
      port: Number(this.publicOrigin.port || (this.publicOrigin.protocol === 'https:' ? 443 : 80)),
      useSSL: this.publicOrigin.protocol === 'https:',
      accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
      secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
      region: process.env.MINIO_REGION ?? 'us-east-1',
    });
  }
  presignedPut(objectKey: string, contentType: string, expiresSeconds: number) {
    return this.signingClient
      .presignedPutObject(this.bucket, objectKey, expiresSeconds)
      .then((signed) => this.publicUrl(signed));
  }
  presignedGet(objectKey: string, expiresSeconds: number) {
    return this.signingClient
      .presignedGetObject(this.bucket, objectKey, expiresSeconds)
      .then((signed) => this.publicUrl(signed));
  }
  private publicUrl(signed: string) {
    const url = new URL(signed);
    url.protocol = this.publicOrigin.protocol;
    url.host = this.publicOrigin.host;
    return url.toString();
  }
  ready() {
    return this.client.bucketExists(this.bucket);
  }
}

export class LiveKitTokenSigner implements ConferenceTokenSigner {
  async sign(input: {
    roomName: string;
    participantId: string;
    identity: string;
    grants: ConferenceGrant;
    ttlSeconds: number;
  }) {
    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY ??
        (process.env.NODE_ENV === 'production'
          ? (() => {
              throw new Error('LIVEKIT_API_KEY is required');
            })()
          : ''),
      process.env.LIVEKIT_API_SECRET ??
        (process.env.NODE_ENV === 'production'
          ? (() => {
              throw new Error('LIVEKIT_API_SECRET is required');
            })()
          : ''),
      { identity: input.identity, ttl: input.ttlSeconds },
    );
    const grant = {
      room: input.roomName,
      roomJoin: true,
      canSubscribe: input.grants.canSubscribe,
      canPublish: input.grants.canPublishAudio || input.grants.canPublishVideo || input.grants.canPublishScreen,
      canPublishSources: liveKitSourcesFor(input.grants),
    };
    token.addGrant(grant);
    return token.toJwt();
  }
  ready() {
    return Boolean(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
  }
}

export type LiveKitParticipantPermissions = {
  canSubscribe: boolean;
  canPublishAudio: boolean;
  canPublishVideo: boolean;
  canPublishScreen: boolean;
};
export const liveKitSourcesFor = (permissions: Pick<LiveKitParticipantPermissions, 'canPublishAudio' | 'canPublishVideo' | 'canPublishScreen'>) => [
  ...(permissions.canPublishAudio ? [TrackSource.MICROPHONE] : []),
  ...(permissions.canPublishVideo ? [TrackSource.CAMERA] : []),
  ...(permissions.canPublishScreen ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []),
];
export interface LiveKitRoomService {
  updateParticipant(room: string, identity: string, permissions: LiveKitParticipantPermissions): Promise<void>;
  removeParticipant(room: string, identity: string): Promise<void>;
  ready(): Promise<boolean>;
}
export class LiveKitRoomServiceAdapter implements LiveKitRoomService {
  private readonly client: RoomServiceClient;
  constructor(
    url = process.env.LIVEKIT_API_URL ?? 'http://livekit:7880',
    key = process.env.LIVEKIT_API_KEY ?? '',
    secret = process.env.LIVEKIT_API_SECRET ?? '',
  ) { this.client = new RoomServiceClient(url, key, secret); }
  async updateParticipant(room: string, identity: string, permissions: LiveKitParticipantPermissions) {
    await this.client.updateParticipant(room, identity, {
      permission: {
        canSubscribe: permissions.canSubscribe,
        canPublish: permissions.canPublishAudio || permissions.canPublishVideo || permissions.canPublishScreen,
        canPublishSources: liveKitSourcesFor(permissions),
      },
    });
  }
  async removeParticipant(room: string, identity: string) { await this.client.removeParticipant(room, identity); }
  async ready() {
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) return false;
    try { await this.client.listRooms(); return true; } catch { return false; }
  }
}

/** Durable asset projection shared with media-worker's Prisma updates. */
export class PrismaMediaAssetStore {
  constructor(private readonly db = new PrismaClient()) {}
  async upsert(asset: {
    id: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    roomId: string;
    expiresAt: string;
  }) {
    await this.db.mediaAsset.upsert({
      where: { id: asset.id },
      create: {
        id: asset.id,
        objectKey: asset.objectKey,
        contentType: asset.contentType,
        sizeBytes: BigInt(asset.sizeBytes),
        roomId: asset.roomId,
        expiresAt: new Date(asset.expiresAt),
      },
      update: {
        objectKey: asset.objectKey,
        contentType: asset.contentType,
        sizeBytes: BigInt(asset.sizeBytes),
        roomId: asset.roomId,
        expiresAt: new Date(asset.expiresAt),
      },
    });
  }
  async get(id: string) {
    const asset = await this.db.mediaAsset.findUnique({
      where: { id },
      include: { subtitles: true },
    });
    if (!asset) return undefined;
    return {
      ...asset,
      sizeBytes: Number(asset.sizeBytes),
      expiresAt: asset.expiresAt.toISOString(),
      status: asset.durationSeconds == null ? 'pending' : 'completed',
    } as Record<string, unknown>;
  }
  async createSubtitle(input: { id: string; assetId: string; language: string; format: 'VTT' | 'SRT'; objectKey: string }) {
    await this.db.subtitleTrack.upsert({ where: { id: input.id }, create: { ...input, status: 'PENDING' }, update: { objectKey: input.objectKey, status: 'PENDING' } });
  }
  async subtitles(assetId: string) {
    const tracks = await this.db.subtitleTrack.findMany({ where: { assetId } });
    return tracks.map((track) => ({ ...track, status: track.status } as Record<string, unknown>));
  }
}
