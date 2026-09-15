import type Redis from 'ioredis';

export type LiveSnapshot = {
  provider: string;
  mediaId: string;
  positionMs: number;
  isPlaying: boolean;
  version: number;
  capturedAt: string;
};
export type Presence = { participantId: string; lastSeenAt: string };

function isLiveSnapshot(value: unknown): value is LiveSnapshot {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.provider === 'string' &&
    typeof item.mediaId === 'string' &&
    typeof item.positionMs === 'number' &&
    Number.isFinite(item.positionMs) &&
    item.positionMs >= 0 &&
    typeof item.isPlaying === 'boolean' &&
    typeof item.version === 'number' &&
    Number.isInteger(item.version) &&
    item.version >= 0 &&
    typeof item.capturedAt === 'string'
  );
}

export interface LiveStateStore {
  getSnapshot(roomId: string): Promise<LiveSnapshot | null>;
  setSnapshot(roomId: string, snapshot: LiveSnapshot, ttlSeconds: number): Promise<void>;
  getPresence(roomId: string): Promise<Presence[]>;
  touchPresence(roomId: string, participantId: string, ttlSeconds: number): Promise<void>;
  removePresence(roomId: string, participantId: string): Promise<void>;
}

export class RedisLiveStateStore implements LiveStateStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'wwm',
  ) {}
  private key(kind: string, room: string) {
    return `${this.prefix}:${kind}:${room}`;
  }
  private presenceKey(room: string, participant: string) {
    return `${this.key('presence', room)}:${participant}`;
  }
  private validateTtl(ttlSeconds: number) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0)
      throw new Error('TTL must be a positive integer');
  }
  async getSnapshot(roomId: string) {
    const raw = await this.redis.get(this.key('snapshot', roomId));
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isLiveSnapshot(parsed)) return parsed;
    } catch {
      /* remove malformed values below */
    }
    await this.redis.del(this.key('snapshot', roomId));
    return null;
  }
  async setSnapshot(roomId: string, snapshot: LiveSnapshot, ttlSeconds: number) {
    this.validateTtl(ttlSeconds);
    await this.redis.set(this.key('snapshot', roomId), JSON.stringify(snapshot), 'EX', ttlSeconds);
  }
  async getPresence(roomId: string) {
    const index = this.key('presence-index', roomId);
    const ids = await this.redis.smembers(index);
    if (!ids.length) return [];
    const values = await this.redis.mget(ids.map((id) => this.presenceKey(roomId, id)));
    const active: Presence[] = [];
    const stale: string[] = [];
    values.forEach((value, index) =>
      value
        ? active.push({ participantId: ids[index], lastSeenAt: value })
        : stale.push(ids[index]),
    );
    if (stale.length) await this.redis.srem(index, ...stale);
    return active;
  }
  async touchPresence(roomId: string, participantId: string, ttlSeconds: number) {
    this.validateTtl(ttlSeconds);
    await this.redis.set(
      this.presenceKey(roomId, participantId),
      new Date().toISOString(),
      'EX',
      ttlSeconds,
    );
    await this.redis.sadd(this.key('presence-index', roomId), participantId);
  }
  async removePresence(roomId: string, participantId: string) {
    await this.redis.del(this.presenceKey(roomId, participantId));
    await this.redis.srem(this.key('presence-index', roomId), participantId);
  }
}

export class InMemoryLiveStateStore implements LiveStateStore {
  private snapshots = new Map<string, LiveSnapshot>();
  private snapshotExpiry = new Map<string, number>();
  private presence = new Map<string, Map<string, Presence>>();
  private presenceExpiry = new Map<string, Map<string, number>>();
  async getSnapshot(roomId: string) {
    const expiry = this.snapshotExpiry.get(roomId);
    if (expiry !== undefined && expiry <= Date.now()) {
      this.snapshots.delete(roomId);
      this.snapshotExpiry.delete(roomId);
      return null;
    }
    const value = this.snapshots.get(roomId);
    return value ? (JSON.parse(JSON.stringify(value)) as LiveSnapshot) : null;
  }
  async setSnapshot(roomId: string, snapshot: LiveSnapshot, ttlSeconds = 60) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0)
      throw new Error('TTL must be a positive integer');
    this.snapshots.set(roomId, JSON.parse(JSON.stringify(snapshot)) as LiveSnapshot);
    this.snapshotExpiry.set(roomId, Date.now() + ttlSeconds * 1000);
  }
  async getPresence(roomId: string) {
    const room = this.presence.get(roomId);
    const expiry = this.presenceExpiry.get(roomId);
    if (!room || !expiry) return [];
    for (const [id, at] of expiry)
      if (at <= Date.now()) {
        room.delete(id);
        expiry.delete(id);
      }
    return [...room.values()].map((value) => ({ ...value }));
  }
  async touchPresence(roomId: string, participantId: string, ttlSeconds = 60) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0)
      throw new Error('TTL must be a positive integer');
    let room = this.presence.get(roomId);
    if (!room) {
      room = new Map();
      this.presence.set(roomId, room);
    }
    let expiry = this.presenceExpiry.get(roomId);
    if (!expiry) {
      expiry = new Map();
      this.presenceExpiry.set(roomId, expiry);
    }
    room.set(participantId, { participantId, lastSeenAt: new Date().toISOString() });
    expiry.set(participantId, Date.now() + ttlSeconds * 1000);
  }
  async removePresence(roomId: string, participantId: string) {
    this.presence.get(roomId)?.delete(participantId);
    this.presenceExpiry.get(roomId)?.delete(participantId);
  }
}
