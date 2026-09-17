import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Server } from 'socket.io';
import { PrismaRoomRepository } from './prisma-room-repository';
import {
  CONTRACT_VERSION,
  CommandEnvelope,
  type Command,
  CreateRoomRequest,
  JoinRoomRequest,
  type PlaybackSnapshot,
  type Snapshot,
  type VideoProvider,
  ServerEvent,
  UploadIntent,
  UploadComplete,
} from '@watch-with-me/contracts';
import {
  EphemeralChatStore,
  InMemoryKeyValueStore,
  InMemoryMediaAssetStore,
  UploadService,
  normalizeProviderUrl,
  type KeyValueStore,
  type ObjectStore,
  type MediaJob,
  type MediaAssetStore,
} from './services/collaboration';
import {
  ConferenceService,
  FakeConferenceSigner,
  type ConferenceTokenSigner,
} from './services/conference';
import {
  MinioObjectStore,
  RedisKeyValueStore,
  LiveKitTokenSigner,
  LiveKitRoomServiceAdapter,
  type LiveKitRoomService,
  PrismaMediaAssetStore,
} from './adapters';
import { createTurnIceServer } from './turn-credentials';

type Participant = { id: string; role: 'host' | 'viewer' };
const MAX_CAS_RETRIES = 3;
export type StoredParticipant = Participant & {
  tokenHash: string;
  displayName: string;
  online: boolean;
  revokedAt?: string;
};
export type Room = {
  code: string;
  participants: Map<string, StoredParticipant>;
  playback: PlaybackSnapshot | null;
  revision: number;
  sequence: number;
  commands: Map<string, number>;
  status?: 'ACTIVE' | 'EXPIRED' | 'CLOSED';
  expiresAt?: string;
  conferenceEnabled?: boolean;
};
export const MAX_PARTICIPANTS = 10;
export interface RoomRepository {
  create(room: Room): Promise<void>;
  get(code: string): Promise<Room | undefined>;
  save(room: Room, expectedSequence?: number): Promise<boolean>;
}
export class InMemoryRoomRepository implements RoomRepository {
  private readonly rooms = new Map<string, Room>();
  private copy(room: Room): Room {
    return {
      ...room,
      participants: new Map([...room.participants].map(([id, p]) => [id, { ...p }])),
      commands: new Map(room.commands),
      playback: room.playback ? { ...room.playback } : null,
    };
  }
  async create(room: Room) {
    this.rooms.set(room.code, this.copy(room));
  }
  async get(code: string) {
    const room = this.rooms.get(code);
    return room ? this.copy(room) : undefined;
  }
  async save(room: Room, expectedSequence?: number): Promise<boolean> {
    const current = this.rooms.get(room.code);
    if (current && expectedSequence !== undefined && current.sequence !== expectedSequence)
      return false;
    this.rooms.set(room.code, this.copy(room));
    return true;
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');
const code = () => secret(8).slice(0, 10).toUpperCase();
const now = () => new Date().toISOString();
const same = (a: string, b: string) => {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

/** Validate media identifiers without making any server-side request (SSRF-safe by design). */
export function validateMedia(provider: VideoProvider, value: string): boolean {
  if (
    value.length > 2048 ||
    [...value].some((char) => {
      const n = char.charCodeAt(0);
      return n < 32 || n === 127;
    })
  )
    return false;
  if (provider === 'youtube') {
    if (/^[A-Za-z0-9_-]{11}$/.test(value)) return true;
    try {
      const u = new URL(value);
      return (
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !u.port &&
        (u.hostname === 'youtube.com' ||
          u.hostname.endsWith('.youtube.com') ||
          u.hostname === 'youtu.be') &&
        (/^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v') ?? '') ||
          /^[A-Za-z0-9_-]{11}$/.test(u.pathname.slice(1)))
      );
    } catch {
      return false;
    }
  }
  if (provider !== 'mp4' && provider !== 'upload') {
    try {
      normalizeProviderUrl(provider, value);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !/\.mp4$/i.test(u.pathname) || u.port) return false;
    const h = u.hostname.toLowerCase();
    if (
      u.username ||
      u.password ||
      h === 'localhost' ||
      h.endsWith('.localhost') ||
      h.endsWith('.local') ||
      h.includes(':') ||
      isIP(h) !== 0 ||
      /^\d+$/.test(h) ||
      h.endsWith('.') ||
      h.endsWith('.internal') ||
      h.endsWith('.corp') ||
      h.endsWith('.home.arpa')
    )
      return false;
    const octets = h.split('.').map(Number);
    const privateV4 =
      octets.length === 4 &&
      octets.every(Number.isInteger) &&
      (octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 169 && octets[1] === 254) ||
        octets[0] === 0);
    return !privateV4;
  } catch {
    return false;
  }
}

export class RoomService {
  constructor(
    private readonly repo: RoomRepository = process.env.NODE_ENV === 'test' ||
    process.env.REALTIME_ROOM_REPOSITORY === 'in-memory'
      ? new InMemoryRoomRepository()
      : (new PrismaRoomRepository() as unknown as RoomRepository),
  ) {}
  async save(room: Room, expectedSequence?: number) {
    return this.repo.save(room, expectedSequence);
  }
  async get(codeValue: string) {
    return this.repo.get(codeValue.toUpperCase());
  }
  async create(displayName: string) {
    const roomCode = code();
    const token = secret(32);
    const p: StoredParticipant = {
      id: randomUUID(),
      role: 'host',
      displayName,
      tokenHash: hash(token),
      online: false,
    };
    const room: Room = {
      code: roomCode,
      participants: new Map([[p.id, p]]),
      playback: null,
      sequence: 0,
      commands: new Map(),
      revision: 0,
      conferenceEnabled: false,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    };
    await this.repo.create(room);
    return { room, token, participantId: p.id };
  }
  async join(roomCode: string, displayName: string) {
    const token = secret(32);
    const p: StoredParticipant = {
      id: randomUUID(),
      role: 'viewer',
      displayName,
      tokenHash: hash(token),
      online: false,
    };
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const room = await this.repo.get(roomCode.toUpperCase());
      if (!room) throw new Error('room_not_found');
      if (room.status !== 'ACTIVE' || (room.expiresAt && Date.parse(room.expiresAt) <= Date.now()))
        throw new Error('room_expired');
      if (room.participants.size >= MAX_PARTICIPANTS) throw new Error('room_full');
      const expected = room.sequence;
      room.participants.set(p.id, p);
      if (await this.repo.save(room, expected)) return { room, token, participantId: p.id };
    }
    throw new Error('state_conflict');
  }
  async authenticate(roomCode: string, token: string) {
    const room = await this.repo.get(roomCode.toUpperCase());
    if (!room) return;
    const record = room as Room & { status?: string; expiresAt?: string | Date };
    if (record.status && record.status !== 'ACTIVE') return;
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return;
    const tokenHash = hash(token);
    for (const p of room.participants.values())
      if (
        same(p.tokenHash, tokenHash) &&
        !(p as StoredParticipant & { revokedAt?: string }).revokedAt
      )
        return { room, participant: p };
  }
  async revoke(roomCode: string, participantId: string) {
    const room = await this.repo.get(roomCode.toUpperCase());
    if (!room) return false;
    const p = room.participants.get(participantId);
    if (!p) return false;
    p.tokenHash = hash(secret(32));
    p.online = false;
    p.revokedAt = now();
    return this.repo.save(room, room.sequence);
  }
  async commitCommandWithRetry(
    roomCode: string,
    participantId: string,
    commandId: string,
    mutate: (room: Room, participant: StoredParticipant) => boolean | string,
  ) {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const room = await this.repo.get(roomCode.toUpperCase());
      if (!room) return { kind: 'missing' as const };
      const participant = room.participants.get(participantId);
      if (!participant) return { kind: 'unauthorized' as const };
      if (room.commands.has(commandId)) return { kind: 'duplicate' as const, room };
      const expected = room.sequence;
      const mutationResult = mutate(room, participant);
      if (!mutationResult) return { kind: 'rejected' as const, room, reason: 'host_only' };
      if (typeof mutationResult === 'string')
        return { kind: 'rejected' as const, room, reason: mutationResult };
      room.commands.set(commandId, room.sequence);
      if (room.commands.size > 1000) {
        const oldest = room.commands.keys().next().value as string | undefined;
        if (oldest) room.commands.delete(oldest);
      }
      room.sequence++;
      room.revision++;
      if (room.playback) room.playback.revision = room.revision;
      if (await this.repo.save(room, expected)) return { kind: 'saved' as const, room };
    }
    return { kind: 'conflict' as const };
  }
  snapshot(room: Room, currentParticipant: Participant): Snapshot {
    const playback = room.playback;
    return {
      version: CONTRACT_VERSION,
      roomId: room.code,
      snapshot: playback,
      participants: [...room.participants.values()].map(({ id, role }) => ({ id, role })),
      currentParticipant: { id: currentParticipant.id, role: currentParticipant.role },
      sequence: room.sequence,
      revision: room.revision,
      serverTime: now(),
    };
  }
}

const app = express();
app.use(express.json({ limit: process.env.REALTIME_MAX_PAYLOAD ?? '32kb' }));
// The web app may be hosted separately from realtime; keep the allow-list explicit.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) return fail(res, 403, 'forbidden');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    if (!origin) return fail(res, 403, 'forbidden');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-room-token');
    return res.sendStatus(204);
  }
  next();
});
const httpServer = createServer(app);
const allowedOrigins = (process.env.REALTIME_ORIGINS ?? '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins.length ? allowedOrigins : false },
  maxHttpBufferSize: 32 * 1024,
});
export const rooms = new RoomService();
// Adapters are real in production and deterministic fakes in tests.  No network client is
// constructed by the test process, which also makes readiness meaningful.
export const keyValue: KeyValueStore =
  process.env.NODE_ENV === 'test' || process.env.REALTIME_ADAPTERS === 'fake'
    ? new InMemoryKeyValueStore()
    : new RedisKeyValueStore();
export const objectStore: ObjectStore =
  process.env.NODE_ENV === 'test' || process.env.REALTIME_ADAPTERS === 'fake'
    ? {
        presignedPut: async (key) => `fake-put://${encodeURIComponent(key)}`,
        presignedGet: async (key) => `fake-get://${encodeURIComponent(key)}`,
      }
    : new MinioObjectStore();
export const conferenceSigner: ConferenceTokenSigner =
  process.env.NODE_ENV === 'test' || process.env.REALTIME_ADAPTERS === 'fake'
    ? new FakeConferenceSigner()
    : new LiveKitTokenSigner();
export const liveKitRoomService: LiveKitRoomService =
  process.env.NODE_ENV === 'test' || process.env.REALTIME_ADAPTERS === 'fake'
    ? { updateParticipant: async () => undefined, removeParticipant: async () => undefined, ready: async () => true }
    : new LiveKitRoomServiceAdapter();
export const chatStore = new EphemeralChatStore(keyValue);
export const uploadService = new UploadService(objectStore);
export const mediaAssets: MediaAssetStore =
  process.env.NODE_ENV === 'test' || process.env.REALTIME_ADAPTERS === 'fake'
    ? new InMemoryMediaAssetStore()
    : new PrismaMediaAssetStore();
const pendingUploads = new Map<
  string,
  {
    assetId: string;
    roomId: string;
    participantId: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    expiresAt: string;
    language?: string;
  }
>();
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const conferencePolicies = new Map<string, boolean>();
const conferenceGrants = new Map<string, Map<string, { canPublishAudio: boolean; canPublishVideo: boolean; canPublishScreen: boolean; canSubscribe: true }>>();
const readiness = {
  redis: process.env.NODE_ENV === 'test' || process.env.REALTIME_ADAPTERS === 'fake',
  minio: process.env.NODE_ENV === 'test' || process.env.REALTIME_ADAPTERS === 'fake',
  livekit: process.env.NODE_ENV === 'test' || process.env.REALTIME_ADAPTERS === 'fake',
};
async function probeReadiness() {
  if (process.env.NODE_ENV === 'test' || process.env.REALTIME_ADAPTERS === 'fake') return readiness;
  const probe = async (value: unknown) => {
    try {
      return (
        typeof (value as { ready?: unknown })?.ready === 'function' &&
        Boolean(await (value as { ready: () => Promise<boolean> | boolean }).ready())
      );
    } catch {
      return false;
    }
  };
  readiness.redis = await probe(keyValue);
  readiness.minio = await probe(objectStore);
  readiness.livekit = await probe(conferenceSigner) && await liveKitRoomService.ready();
  return readiness;
}
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: now(), event, ...fields }));

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ error: message });
const httpBuckets = new Map<string, { at: number; count: number }>();
app.use('/api/rooms', (req, res, next) => {
  if (req.method === 'GET') return next();
  const route = req.path.includes('/join')
    ? 'join'
    : req.path === '/'
      ? 'create'
      : req.path.includes('/conference')
        ? 'conference'
        : req.path.includes('/media')
          ? 'media'
          : 'moderation';
  const limits: Record<string, number> = {
    join: 20,
    create: 10,
    conference: 60,
    media: 40,
    moderation: 60,
  };
  const key = `${route}:${req.ip ?? 'unknown'}`;
  const bucket = httpBuckets.get(key) ?? { at: Date.now(), count: 0 };
  if (Date.now() - bucket.at >= 60_000) {
    bucket.at = Date.now();
    bucket.count = 0;
  }
  if (++bucket.count > limits[route]) {
    res.setHeader('Retry-After', '60');
    return fail(res, 429, 'rate_limited');
  }
  httpBuckets.set(key, bucket);
  // Bound the process-local limiter as well as request bodies.
  if (httpBuckets.size > 10_000) {
    for (const [ip, value] of httpBuckets) {
      if (Date.now() - value.at >= 60_000) httpBuckets.delete(ip);
    }
  }
  return next();
});
const bearer = (req: Request) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return typeof req.headers['x-room-token'] === 'string' ? req.headers['x-room-token'] : '';
};
app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (_req, res) => {
  const state = await probeReadiness();
  const ok = Object.values(state).every(Boolean);
  return res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'not_ready', dependencies: state });
});
app.get('/api/rooms/:code/state', async (req: Request, res: Response) => {
  // Do not reveal whether an arbitrary room code exists to unauthenticated callers.
  const auth = await rooms.authenticate(String(req.params.code), bearer(req));
  if (!auth) return fail(res, 401, 'unauthorized');
  return res.json(rooms.snapshot(auth.room, auth.participant));
});
const authenticated = async (req: Request) =>
  rooms.authenticate(String(req.params.code), bearer(req));
app.post('/api/rooms/:code/leave', async (req: Request, res: Response) => {
  const auth = await authenticated(req);
  if (!auth) return fail(res, 401, 'unauthorized');
  if (auth.participant.role === 'host') {
    const saved = await commit(auth.room.code, (room) => {
      const next = [...room.participants.values()].find(
        (p) => p.id !== auth.participant.id && p.role === 'viewer' && p.online,
      );
      if (next) {
        room.participants.get(auth.participant.id)!.role = 'viewer';
        next.role = 'host';
        room.sequence++;
        room.revision++;
      } else {
        room.status = 'CLOSED';
        room.sequence++;
      }
    });
    if (saved) {
      broadcastParticipants(saved);
      io.to(auth.room.code).emit('host.transfer', {
        participantId: [...saved.participants.values()].find((p) => p.role === 'host')?.id,
      });
      if (saved.status === 'CLOSED')
        io.to(auth.room.code).emit('room.closed', { reason: 'host_left' });
    }
  }
  await rooms.revoke(auth.room.code, auth.participant.id);
  for (const socketId of activeConnections.get(auth.participant.id) ?? [])
    io.sockets.sockets.get(socketId)?.disconnect(true);
  return res.status(204).send();
});
app.post('/api/rooms/:code/transfer-host', async (req: Request, res: Response) => {
  const auth = await authenticated(req);
  const target = typeof req.body?.participantId === 'string' ? req.body.participantId : '';
  if (!auth || auth.participant.role !== 'host') return fail(res, 403, 'forbidden');
  let transferred = false;
  await enqueue(auth.room.code, async () => {
    const room = await rooms.get(auth.room.code);
    const targetParticipant = room?.participants.get(target);
    if (
      !room ||
      room.status !== 'ACTIVE' ||
      !targetParticipant ||
      targetParticipant.id === auth.participant.id
    )
      return;
    const expectedSequence = room.sequence;
    for (const p of room.participants.values()) p.role = p.id === target ? 'host' : 'viewer';
    room.sequence++;
    room.revision++;
    transferred = (await rooms.save(room, expectedSequence)) === true;
  });
  return transferred ? res.json({ ok: true }) : fail(res, 400, 'invalid_request');
});
app.post('/api/rooms/:code/kick', async (req: Request, res: Response) => {
  const auth = await authenticated(req);
  const target = typeof req.body?.participantId === 'string' ? req.body.participantId : '';
  if (!auth || auth.participant.role !== 'host') return fail(res, 403, 'forbidden');
  let kicked = false;
  await enqueue(auth.room.code, async () => {
    const room = await rooms.get(auth.room.code);
    if (
      !room ||
      room.participants.get(auth.participant.id)?.role !== 'host' ||
      !room.participants.has(target) ||
      target === auth.participant.id
    )
      return;
    const victim = room.participants.get(target)!;
    victim.tokenHash = hash(secret(32));
    victim.revokedAt = now();
    victim.online = false;
    room.sequence++;
    kicked = await rooms.save(room, room.sequence - 1);
  });
  if (!kicked) return fail(res, 400, 'invalid_request');
  for (const socketId of activeConnections.get(target) ?? [])
    io.sockets.sockets.get(socketId)?.disconnect(true);
  return res.status(204).send();
});

// Collaboration/media HTTP boundary. Every route authenticates the room capability first;
// host-only operations additionally re-check the authoritative participant role.
const hostAuth = async (req: Request) => {
  const a = await authenticated(req);
  return a && a.participant.role === 'host' ? a : undefined;
};
const enqueueMediaJob = async (job: MediaJob) => keyValue.lpush('media:jobs', JSON.stringify(job));
export const trustedPlaybackAsset = async (roomId: string, value: string) => {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  const publicEndpoint = process.env.MINIO_PUBLIC_ORIGIN ?? `http://${process.env.MINIO_PUBLIC_ENDPOINT ?? 'localhost'}:${process.env.MINIO_PUBLIC_PORT ?? '9000'}`;
  let expected: URL;
  try { expected = new URL(publicEndpoint); } catch { return false; }
  if (parsed.origin !== expected.origin) return false;
  if (parsed.protocol !== 'https:') {
    const insecureLocalMedia =
      process.env.ALLOW_INSECURE_LOCAL_MEDIA === 'true' &&
      expected.protocol === 'http:' &&
      (expected.hostname === 'localhost' || expected.hostname === '127.0.0.1');
    if (!insecureLocalMedia) return false;
  }
  const match = parsed.pathname.match(/\/processed\/([A-Za-z0-9_-]+)\.mp4$/);
  if (!match) return false;
  const asset = await mediaAssets.get(match[1]);
  return Boolean(asset && asset.roomId === roomId && asset.status === 'completed' && asset.objectKey === `processed/${match[1]}.mp4`);
};
app.post('/api/rooms/:code/media/upload-intent', async (req, res) => {
  const a = await hostAuth(req);
  const parsed = UploadIntent.safeParse(req.body);
  if (!a) return fail(res, 403, 'forbidden');
  if (!parsed.success) return fail(res, 400, 'invalid_request');
  try {
    const intent = await uploadService.intent(a.room.code, a.participant.id, parsed.data, true);
    const assetId = randomUUID();
    pendingUploads.set(intent.uploadId, { ...intent, assetId, roomId: a.room.code });
    return res.status(201).json({ ...intent, assetId });
  } catch {
    return fail(res, 400, 'invalid_upload');
  }
});
app.post('/api/rooms/:code/media/upload-complete', async (req, res) => {
  const a = await hostAuth(req);
  const parsed = UploadComplete.safeParse(req.body);
  if (!a) return fail(res, 403, 'forbidden');
  if (!parsed.success) return fail(res, 400, 'invalid_request');
  const pending = pendingUploads.get(parsed.data.uploadId);
  if (
    !pending ||
    pending.roomId !== a.room.code ||
    pending.participantId !== a.participant.id ||
    new Date(pending.expiresAt) <= new Date()
  )
    return fail(res, 404, 'upload_not_found');
  const existing = await mediaAssets.get(pending.assetId);
  if (existing) return res.status(existing.status === 'completed' ? 200 : 202).json(existing);
  await mediaAssets.upsert({
    id: pending.assetId,
    objectKey: pending.objectKey,
    contentType: pending.contentType,
    sizeBytes: pending.sizeBytes,
    roomId: pending.roomId,
    expiresAt: pending.expiresAt,
  });
  await enqueueMediaJob({
    assetId: pending.assetId,
    objectKey: pending.objectKey,
    contentType: pending.contentType,
    sizeBytes: pending.sizeBytes,
    roomId: pending.roomId,
  });
  pendingUploads.delete(parsed.data.uploadId);
  const asset = await mediaAssets.get(pending.assetId);
  return res.status(202).json({ ...asset, checksum: parsed.data.checksum });
});
app.get('/api/rooms/:code/media/:assetId/status', async (req, res) => {
  const a = await authenticated(req);
  if (!a) return fail(res, 401, 'unauthorized');
  const asset = await mediaAssets.get(String(req.params.assetId));
  if (!asset || asset.roomId !== a.room.code) return fail(res, 404, 'not_found');
  return res.json(asset);
});
app.get('/api/rooms/:code/media/:assetId/playback-url', async (req, res) => {
  const a = await authenticated(req);
  if (!a) return fail(res, 401, 'unauthorized');
  const asset = await mediaAssets.get(String(req.params.assetId));
  if (!asset || asset.roomId !== a.room.code) return fail(res, 404, 'not_found');
  return res.json({
    url: await uploadService.playbackUrl(String(asset.objectKey)),
    expiresIn: 300,
  });
});
app.post('/api/rooms/:code/media/subtitle-intent', async (req, res) => {
  const a = await hostAuth(req);
  if (!a) return fail(res, 403, 'forbidden');
  const parsed = UploadIntent.safeParse(req.body);
  if (!parsed.success || !parsed.data.assetId || !parsed.data.language || !['text/vtt', 'application/x-subrip'].includes(parsed.data.contentType))
    return fail(res, 400, 'invalid_request');
  try {
    const intent = await uploadService.intent(a.room.code, a.participant.id, parsed.data, true);
    pendingUploads.set(intent.uploadId, {
      ...intent,
      assetId: parsed.data.assetId,
      roomId: a.room.code,
      language: parsed.data.language,
    });
    return res.status(201).json(intent);
  } catch {
    return fail(res, 400, 'invalid_upload');
  }
});
app.post('/api/rooms/:code/media/subtitle-complete', async (req, res) => {
  const a = await hostAuth(req);
  const parsed = UploadComplete.safeParse(req.body);
  if (!a) return fail(res, 403, 'forbidden');
  if (!parsed.success) return fail(res, 400, 'invalid_request');
  const pending = pendingUploads.get(parsed.data.uploadId);
  if (
    !pending ||
    pending.roomId !== a.room.code ||
    pending.participantId !== a.participant.id ||
    new Date(pending.expiresAt) <= new Date()
  )
    return fail(res, 404, 'upload_not_found');
  const source = await mediaAssets.get(pending.assetId);
  if (!source || source.roomId !== a.room.code || source.status !== 'completed' || !pending.language)
    return fail(res, 400, 'invalid_request');
  const subtitleId = randomUUID();
  await mediaAssets.createSubtitle?.({ id: subtitleId, assetId: pending.assetId, language: pending.language, format: pending.contentType === 'text/vtt' ? 'VTT' : 'SRT', objectKey: pending.objectKey });
  await enqueueMediaJob({ kind: 'subtitle', assetId: pending.assetId, objectKey: pending.objectKey, contentType: pending.contentType as MediaJob['contentType'], sizeBytes: pending.sizeBytes, roomId: pending.roomId, subtitle: { id: subtitleId, language: pending.language, objectKey: pending.objectKey } });
  pendingUploads.delete(parsed.data.uploadId);
  return res.status(202).json({ ok: true, uploadId: parsed.data.uploadId, subtitleId });
});
app.get('/api/rooms/:code/media/:assetId/subtitles', async (req, res) => {
  const a = await authenticated(req);
  if (!a) return fail(res, 401, 'unauthorized');
  const asset = await mediaAssets.get(String(req.params.assetId));
  if (!asset || asset.roomId !== a.room.code) return fail(res, 404, 'not_found');
  const tracks = await mediaAssets.subtitles?.(String(req.params.assetId)) ?? [];
  return res.json({ tracks: await Promise.all(tracks.filter((track) => track.status === 'READY').map(async (track) => ({ ...track, url: await uploadService.playbackUrl(String(track.objectKey)) }))) });
});

const conferenceFor = () => new ConferenceService(conferenceSigner);
const conferenceState = (roomCode: string, participantId?: string) => {
  const grant = participantId ? conferenceGrants.get(roomCode)?.get(participantId) : undefined;
  return { enabled: conferencePolicies.get(roomCode) === true, ownGrant: grant ?? { canPublishAudio: false, canPublishVideo: false, canPublishScreen: false, canSubscribe: true } };
};
const emitConferencePolicy = (roomCode: string) => io.to(roomCode).emit('conference.policy.changed', { enabled: conferencePolicies.get(roomCode) === true, maxParticipants: 10 });
const emitConferenceGrant = (roomCode: string, participantId: string) => io.to(roomCode).emit('conference.grants', { participantId, ...(conferenceGrants.get(roomCode)?.get(participantId) ?? { canPublishAudio: false, canPublishVideo: false, canPublishScreen: false, canSubscribe: true }) });
type ConferenceGrant = { canPublishAudio: boolean; canPublishVideo: boolean; canPublishScreen: boolean; canSubscribe: true };
const noPublishGrant: ConferenceGrant = { canPublishAudio: false, canPublishVideo: false, canPublishScreen: false, canSubscribe: true };
const syncLiveKitGrant = async (roomCode: string, participantId: string, grant: { canPublishAudio: boolean; canPublishVideo: boolean; canPublishScreen: boolean; canSubscribe: true }, revoke = false) => {
  try {
    await liveKitRoomService.updateParticipant(roomCode, participantId, grant);
    if (revoke) await liveKitRoomService.removeParticipant(roomCode, participantId);
  } catch {
    // A participant may not have connected yet; the durable grant map is authoritative for its next token.
  }
};
type ConferenceMutation = 'revoke' | 'mute';
const applyConferenceMutation = async (roomCode: string, actorId: string, targetId: string | undefined, mutation: ConferenceMutation) => {
  const fresh = await rooms.get(roomCode);
  if (!fresh || fresh.participants.get(actorId)?.role !== 'host' || !targetId || !fresh.participants.has(targetId)) return 'forbidden' as const;
  try {
    // Update permissions in place: revoke/mute must stop publishing without
    // disconnecting the viewer, so subscriptions and the existing room stay alive.
    await liveKitRoomService.updateParticipant(roomCode, targetId, noPublishGrant);
  } catch {
    return 'livekit_sync_failed' as const;
  }
  const grants = conferenceGrants.get(roomCode) ?? new Map<string, ConferenceGrant>();
  if (mutation === 'revoke') grants.delete(targetId);
  else grants.set(targetId, noPublishGrant);
  conferenceGrants.set(roomCode, grants);
  emitConferenceGrant(roomCode, targetId);
  return 'ok' as const;
};
app.post('/api/rooms/:code/conference/token', async (req, res) => {
  const a = await authenticated(req);
  if (!a) return fail(res, 401, 'unauthorized');
  if (!conferencePolicies.has(a.room.code)) conferencePolicies.set(a.room.code, a.room.conferenceEnabled === true);
  const state = conferenceState(a.room.code, a.participant.id);
  try {
    const token = await conferenceFor().issue(
      a.room.code,
      a.participant.id,
      a.participant.role === 'host',
      { enabled: state.enabled, requireHostApproval: true },
      state.ownGrant,
    );
     const turnSecret = process.env.TURN_SHARED_SECRET;
     if (!turnSecret) return fail(res, 503, 'turn_not_configured');
     const iceServers = [createTurnIceServer({ participantId: a.participant.id, expiresAt: token.expiresAt, secret: turnSecret, url: process.env.TURN_URL ?? 'turn:localhost:3478?transport=tcp' })];
     return res.json({ version: 'v1', ...token, iceServers });
  } catch (e) {
    return fail(res, 403, e instanceof Error ? e.message : 'forbidden');
  }
});
app.post('/api/rooms/:code/conference/policy', async (req, res) => {
  const a = await hostAuth(req);
  if (!a) return fail(res, 403, 'forbidden');
  const enabled = req.body?.enabled === true;
  let saved = false;
  await enqueue(a.room.code, async () => {
    const room = await rooms.get(a.room.code);
    if (!room || room.participants.get(a.participant.id)?.role !== 'host') return;
    const expected = room.sequence;
    room.conferenceEnabled = enabled;
    room.sequence++;
    if (!(await rooms.save(room, expected))) return;
    conferencePolicies.set(a.room.code, enabled);
    saved = true;
    emitConferencePolicy(a.room.code);
  });
  if (!saved) return fail(res, 503, 'persistence_failed');
  return res.json({ ...conferenceState(a.room.code), maxParticipants: 10, requireHostApproval: true });
});
app.get('/api/rooms/:code/conference/status', async (req, res) => {
  const a = await authenticated(req);
  if (!a) return fail(res, 401, 'unauthorized');
  if (!conferencePolicies.has(a.room.code)) conferencePolicies.set(a.room.code, a.room.conferenceEnabled === true);
  return res.json({ enabled: conferencePolicies.get(a.room.code) === true, ownGrant: a.participant.role === 'host' ? { canPublishAudio: true, canPublishVideo: true, canPublishScreen: true, canSubscribe: true } : conferenceState(a.room.code, a.participant.id).ownGrant, maxParticipants: 10 });
});
app.post('/api/rooms/:code/conference/grant', async (req, res) => {
  const a = await hostAuth(req);
  const id = String(req.body?.participantId ?? '');
  if (!a || !a.room.participants.has(id)) return fail(res, 403, 'forbidden');
  const grants = conferenceGrants.get(a.room.code) ?? new Map();
  if (!grants.has(id) && grants.size >= 5) return fail(res, 409, 'publisher_limit');
  const grant = { canPublishAudio: true, canPublishVideo: true, canPublishScreen: true, canSubscribe: true as const };
  grants.set(id, grant); conferenceGrants.set(a.room.code, grants); await syncLiveKitGrant(a.room.code, id, grant); emitConferenceGrant(a.room.code, id);
  return res.json({ participantId: id, ...grant });
});
app.post('/api/rooms/:code/conference/revoke', async (req, res) => {
  const a = await hostAuth(req);
  if (!a) return fail(res, 403, 'forbidden');
  const result = await applyConferenceMutation(a.room.code, a.participant.id, req.body?.participantId, 'revoke');
  if (result === 'forbidden') return fail(res, 403, 'forbidden');
  if (result !== 'ok') return fail(res, 503, result);
  return res.status(204).send();
});
app.post('/api/rooms', async (req: Request, res: Response) => {
  const parsed = CreateRoomRequest.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'invalid_request');
  const x = await rooms.create(parsed.data.displayName);
  log('room_created', { roomCode: x.room.code });
  return res.status(201).json({
    version: CONTRACT_VERSION,
    roomId: x.room.code,
    roomCode: x.room.code,
    token: x.token,
    participantId: x.participantId,
    role: 'host',
    serverTime: now(),
  });
});
app.post('/api/rooms/:code/join', async (req: Request, res: Response) => {
  const roomCode = String(req.params.code);
  const parsed = JoinRoomRequest.safeParse({ ...req.body, roomId: roomCode });
  if (!parsed.success) return fail(res, 400, 'invalid_request');
  try {
    let x: Awaited<ReturnType<RoomService['join']>> | undefined;
    await enqueue(roomCode, async () => {
      x = await rooms.join(roomCode, parsed.data.displayName);
    });
    if (!x) return fail(res, 409, 'state_conflict');
    return res.status(201).json({
      version: CONTRACT_VERSION,
      roomId: x.room.code,
      roomCode: x.room.code,
      token: x.token,
      participantId: x.participantId,
      role: 'viewer',
      serverTime: now(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'room_full') return fail(res, 409, 'room_full');
    if (error instanceof Error && error.message === 'state_conflict')
      return fail(res, 409, 'state_conflict');
    return fail(res, 404, 'room_not_found');
  }
});
app.use((error: unknown, _req: Request, res: Response, next: unknown) => {
  void next;
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large')
    return fail(res, 413, 'payload_too_large');
  return fail(res, 400, 'invalid_request');
});

const emitWire = (
  target: { emit: (event: string, payload: unknown) => void },
  event: string,
  payload: unknown,
) => target.emit(event, ServerEvent.parse(payload));
const emitError = (
  socket: { emit: (event: string, payload: unknown) => void },
  message: string,
  commandId?: string,
) =>
  emitWire(socket, 'error', {
    type: 'error',
    eventId: randomUUID(),
    ...(commandId ? { commandId } : {}),
    sequence: 0,
    revision: 0,
    serverTime: now(),
    message,
  });
io.use(async (socket, next) => {
  const a = socket.handshake.auth as Record<string, unknown>;
  const roomCode =
    typeof a.roomCode === 'string' ? a.roomCode : typeof a.roomId === 'string' ? a.roomId : '';
  const token = typeof a.token === 'string' ? a.token : '';
  const auth = await rooms.authenticate(roomCode, token);
  if (!auth) return next(new Error('unauthorized'));
  socket.data.room = auth.room;
  socket.data.participant = auth.participant;
  socket.data.token = token;
  next();
});
const buckets = new Map<string, { at: number; count: number }>();
const chatBuckets = new Map<string, { at: number; count: number }>();
const chatQueues = new Map<string, Promise<void>>();
const enqueueChat = (roomId: string, work: () => Promise<void>) => {
  const next = (chatQueues.get(roomId) ?? Promise.resolve()).catch(() => undefined).then(work);
  chatQueues.set(roomId, next);
  void next.finally(() => {
    if (chatQueues.get(roomId) === next) chatQueues.delete(roomId);
  });
  return next;
};
const activeConnections = new Map<string, Set<string>>();
const roomQueues = new Map<string, Promise<void>>();
function enqueue(roomCode: string, work: () => Promise<void>) {
  const previous = roomQueues.get(roomCode) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  // Cleanup must resolve independently so a rejected work promise remains observable.
  const cleanup = next.then(
    () => {
      if (roomQueues.get(roomCode) === cleanup) roomQueues.delete(roomCode);
    },
    () => {
      if (roomQueues.get(roomCode) === cleanup) roomQueues.delete(roomCode);
    },
  );
  roomQueues.set(roomCode, cleanup);
  return next;
}
const commit = async (roomCode: string, mutate: (room: Room) => boolean | void) => {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const authoritative = await rooms.get(roomCode);
    if (!authoritative) return undefined;
    const expected = authoritative.sequence;
    if (mutate(authoritative) === false) return undefined;
    if (await rooms.save(authoritative, expected)) return authoritative;
  }
  return null;
};
const participantData = (room: Room) =>
  [...room.participants.values()].map(({ id, role }) => ({ id, role }));
const broadcastParticipants = (room: Room) =>
  emitWire(io.to(room.code), 'participants', {
    type: 'participants',
    eventId: randomUUID(),
    sequence: room.sequence,
    revision: room.revision,
    serverTime: now(),
    data: participantData(room),
  });
io.on('connection', (socket) => {
  const room = socket.data.room as Room;
  const participant = socket.data.participant as StoredParticipant;
  const pendingDisconnect = disconnectTimers.get(participant.id);
  if (pendingDisconnect) {
    clearTimeout(pendingDisconnect);
    disconnectTimers.delete(participant.id);
  }
  socket.join(room.code);
  if (!conferencePolicies.has(room.code)) conferencePolicies.set(room.code, room.conferenceEnabled === true);
  socket.emit('conference.policy.changed', { enabled: conferencePolicies.get(room.code) === true, maxParticipants: 10 });
  socket.emit('conference.grants', { participantId: participant.id, ...(conferenceGrants.get(room.code)?.get(participant.id) ?? { canPublishAudio: participant.role === 'host', canPublishVideo: participant.role === 'host', canPublishScreen: participant.role === 'host', canSubscribe: true }) });
  const connections = activeConnections.get(participant.id) ?? new Set<string>();
  connections.add(socket.id);
  activeConnections.set(participant.id, connections);
  void enqueue(room.code, async () => {
    const saved = await commit(room.code, (authoritative) => {
      const p = authoritative.participants.get(participant.id);
      if (!p) return;
      p.online = true;
      authoritative.sequence++;
    });
    if (!saved || saved === null) return emitError(socket, 'state_conflict');
    broadcastParticipants(saved);
    socket.emit('ready', { version: CONTRACT_VERSION });
    emitWire(socket, 'snapshot', {
      type: 'snapshot',
      eventId: randomUUID(),
      sequence: saved.sequence,
      revision: saved.revision,
      serverTime: now(),
      data: rooms.snapshot(saved, saved.participants.get(participant.id)!),
    });
  }).catch((error: unknown) => {
    log('room_queue_error', {
      roomCode: room.code,
      error: error instanceof Error ? error.message : 'unknown',
    });
  });
  const handle = async (raw: unknown) =>
    enqueue(room.code, async (): Promise<void> => {
      const session = await rooms.authenticate(room.code, String(socket.data.token ?? ''));
      if (!session || session.participant.id !== participant.id) {
        socket.disconnect(true);
        return emitError(socket, 'unauthorized');
      }
      const envelope = CommandEnvelope.safeParse(raw);
      if (!envelope.success) return emitError(socket, 'invalid_command');
      const fresh = await rooms.get(room.code);
      if (!fresh) return emitError(socket, 'room_not_found');
      Object.assign(room, fresh);
      const currentParticipant = room.participants.get(participant.id);
      if (!currentParticipant) return emitError(socket, 'unauthorized');
      const { commandId, command } = envelope.data;
      const bucketKey = `command:${room.code}:${participant.id}`;
      const bucket = buckets.get(bucketKey) ?? { at: Date.now(), count: 0 };
      if (Date.now() - bucket.at > 1000) {
        bucket.at = Date.now();
        bucket.count = 0;
      }
      if (++bucket.count > 30) return emitError(socket, 'rate_limited', commandId);
      buckets.set(bucketKey, bucket);
      if (room.commands.has(commandId)) {
        emitWire(socket, 'snapshot', {
          type: 'snapshot',
          eventId: randomUUID(),
          sequence: room.sequence,
          revision: room.revision,
          serverTime: now(),
          data: rooms.snapshot(room, currentParticipant),
        });
        return;
      }
      if (command.type !== 'request_state' && currentParticipant.role !== 'host') {
        emitWire(socket, 'command_rejected', {
          type: 'command_rejected',
          eventId: randomUUID(),
          commandId,
          sequence: room.sequence,
          revision: room.revision,
          serverTime: now(),
          reason: 'host_only',
        });
        return;
      }
      if (command.type === 'request_state') {
        room.commands.set(commandId, room.sequence);
        emitWire(socket, 'snapshot', {
          type: 'snapshot',
          eventId: randomUUID(),
          sequence: room.sequence,
          revision: room.revision,
          serverTime: now(),
          data: rooms.snapshot(room, currentParticipant),
        });
        return;
      }
      const loadCommand = command as Extract<Command, { type: 'load' }>;
      const validLoad = command.type !== 'load'
        || (loadCommand.provider === 'upload'
          ? await trustedPlaybackAsset(room.code, loadCommand.videoId)
          : validateMedia(loadCommand.provider, loadCommand.videoId));
      if (!validLoad) {
        emitWire(socket, 'command_rejected', {
          type: 'command_rejected',
          eventId: randomUUID(),
          commandId,
          sequence: room.sequence,
          revision: room.revision,
          serverTime: now(),
          reason: 'invalid_media',
        });
        return;
      }
      if (
        (command.type === 'play' || command.type === 'pause' || command.type === 'seek') &&
        room.playback &&
        (room.playback.syncMode === 'view_only' ||
          !['youtube', 'mp4', 'upload'].includes(room.playback.provider))
      ) {
        return emitWire(socket, 'command_rejected', {
          type: 'command_rejected',
          eventId: randomUUID(),
          commandId,
          sequence: room.sequence,
          revision: room.revision,
          serverTime: now(),
          reason: 'view_only_provider',
        });
      }
      const result = await rooms.commitCommandWithRetry(
        room.code,
        participant.id,
        commandId,
        (authoritative, currentParticipant) => {
          if (currentParticipant.role !== 'host') return false;
          if (
            (command.type === 'play' || command.type === 'pause' || command.type === 'seek') &&
            !authoritative.playback
          )
            return 'no_media_loaded';
          if (command.type === 'load') {
            authoritative.playback = {
              provider: loadCommand.provider,
              videoId:
                [
                  'youtube',
                  'instagram',
                  'tiktok',
                  'vimeo',
                  'dailymotion',
                  'twitch',
                  'facebook',
                ].includes(loadCommand.provider) && loadCommand.videoId.includes('://')
                  ? normalizeProviderUrl(loadCommand.provider, loadCommand.videoId)
                  : loadCommand.videoId,
              status: 'paused',
              positionSeconds: 0,
              updatedAt: now(),
              revision: authoritative.revision + 1,
              durationSeconds: loadCommand.durationSeconds,
              syncMode:
                loadCommand.syncMode ??
                (['instagram', 'tiktok', 'vimeo', 'dailymotion', 'twitch', 'facebook'].includes(
                  loadCommand.provider,
                )
                  ? 'view_only'
                  : 'full'),
            };
          } else if (authoritative.playback) {
            const previousUpdatedAt = authoritative.playback.updatedAt;
            const wasPlaying = authoritative.playback.status === 'playing';
            const playback: PlaybackSnapshot = {
              ...authoritative.playback,
              updatedAt: now(),
              revision: authoritative.revision + 1,
            };
            const duration = playback.durationSeconds;
            if (command.type === 'play') playback.status = 'playing';
            else if (command.type === 'pause') {
              if (wasPlaying)
                playback.positionSeconds += Math.max(
                  0,
                  (Date.now() - Date.parse(previousUpdatedAt)) / 1000,
                );
              playback.status = 'paused';
            } else if (command.type === 'seek')
              playback.positionSeconds =
                duration == null
                  ? command.positionSeconds
                  : Math.min(command.positionSeconds, duration);
            if (duration != null)
              playback.positionSeconds = Math.min(playback.positionSeconds, duration);
            authoritative.playback = playback;
          }
          return true;
        },
      );
      if (result.kind === 'duplicate') {
        emitWire(socket, 'snapshot', {
          type: 'snapshot',
          eventId: randomUUID(),
          sequence: result.room.sequence,
          revision: result.room.revision,
          serverTime: now(),
          data: rooms.snapshot(result.room, result.room.participants.get(participant.id)!),
        });
        return;
      }
      if (result.kind === 'unauthorized' || result.kind === 'missing')
        return emitError(socket, result.kind);
      if (result.kind === 'rejected') {
        emitWire(socket, 'command_rejected', {
          type: 'command_rejected',
          eventId: randomUUID(),
          commandId,
          sequence: result.room.sequence,
          revision: result.room.revision,
          serverTime: now(),
          reason: result.reason,
        });
        return;
      }
      if (result.kind === 'conflict') {
        emitWire(socket, 'command_rejected', {
          type: 'command_rejected',
          eventId: randomUUID(),
          commandId,
          sequence: room.sequence,
          revision: room.revision,
          serverTime: now(),
          reason: 'stale_state',
        });
        return;
      }
      const publicPlayback = result.room.playback;
      emitWire(io.to(room.code), 'playback_changed', {
        type: 'playback_changed',
        eventId: randomUUID(),
        sequence: result.room.sequence,
        revision: result.room.revision,
        serverTime: now(),
        data: publicPlayback,
      });
    });
  socket.on('command', handle);
  socket.on('request_state', () =>
    handle({
      version: CONTRACT_VERSION,
      commandId: randomUUID(),
      command: { type: 'request_state' },
    }),
  );
  const emitRoom = (event: string, data: unknown) => io.to(room.code).emit(event, data);
  socket.on('chat.send', async (raw: unknown, ack?: (value: unknown) => void) => {
    await enqueueChat(room.code, async () => {
      const session = await rooms.authenticate(room.code, String(socket.data.token ?? ''));
      if (!session || session.participant.id !== participant.id)
        return ack?.({ error: 'unauthorized' });
      const bucketKey = `chat:${room.code}:${participant.id}`;
      const bucket = chatBuckets.get(bucketKey) ?? { at: Date.now(), count: 0 };
      if (Date.now() - bucket.at >= 60_000) {
        bucket.at = Date.now();
        bucket.count = 0;
      }
      if (++bucket.count > 60) return ack?.({ error: 'rate_limited' });
      chatBuckets.set(bucketKey, bucket);
      const text = typeof raw === 'string' ? raw : (raw as { text?: unknown })?.text;
      const clientMessageId =
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as { clientMessageId?: unknown }).clientMessageId === 'string'
          ? (raw as { clientMessageId: string }).clientMessageId
          : undefined;
      if (typeof text !== 'string') return ack?.({ error: 'invalid_request' });
      try {
        const message = await chatStore.send(
          room.code,
          participant.id,
          text,
          clientMessageId,
          Date.now(),
        );
        emitRoom('chat.message', message);
        ack?.(message);
      } catch {
        ack?.({ error: 'invalid_message' });
      }
    });
  });
  socket.on('chat.history', async (_raw: unknown, ack?: (value: unknown) => void) =>
    (await rooms.authenticate(room.code, String(socket.data.token ?? '')))
      ? ack?.(await chatStore.history(room.code))
      : ack?.({ error: 'unauthorized' }),
  );
  socket.on('chat.delete', async (raw: unknown, ack?: (value: unknown) => void) => {
    const session = await rooms.authenticate(room.code, String(socket.data.token ?? ''));
    if (!session || session.participant.id !== participant.id)
      return ack?.({ error: 'unauthorized' });
    const id = typeof raw === 'string' ? raw : (raw as { messageId?: string })?.messageId;
    const fresh = await rooms.get(room.code);
    if (!fresh || fresh.participants.get(participant.id)?.role !== 'host' || !id)
      return ack?.({ error: 'forbidden' });
    await chatStore.remove(room.code, id);
    emitRoom('chat.deleted', { messageId: id });
    ack?.({ ok: true });
  });
  socket.on('moderation.kick', async (raw: unknown, ack?: (value: unknown) => void) => {
    const session = await rooms.authenticate(room.code, String(socket.data.token ?? ''));
    if (!session || session.participant.id !== participant.id)
      return ack?.({ error: 'unauthorized' });
    const target = (raw as { participantId?: string })?.participantId;
    const fresh = await rooms.get(room.code);
    if (
      !fresh ||
      fresh.participants.get(participant.id)?.role !== 'host' ||
      !target ||
      target === participant.id
    )
      return ack?.({ error: 'forbidden' });
    await enqueue(room.code, async () => {
      const current = await rooms.get(room.code);
      if (
        !current ||
        current.participants.get(participant.id)?.role !== 'host' ||
        !current.participants.has(target)
      )
        return;
      const victim = current.participants.get(target)!;
      victim.tokenHash = hash(secret(32));
      victim.revokedAt = now();
      victim.online = false;
      current.sequence++;
      await rooms.save(current, current.sequence - 1);
      for (const id of activeConnections.get(target) ?? [])
        io.sockets.sockets.get(id)?.disconnect(true);
      emitRoom('participants', { participants: participantData(current) });
    });
    ack?.({ ok: true });
  });
  socket.on('moderation.mute', async (raw: unknown, ack?: (value: unknown) => void) => {
    const session = await rooms.authenticate(room.code, String(socket.data.token ?? ''));
    if (!session || session.participant.id !== participant.id)
      return ack?.({ error: 'unauthorized' });
    const result = await applyConferenceMutation(room.code, participant.id, (raw as { participantId?: string })?.participantId, 'mute');
    return ack?.(result === 'ok' ? { ok: true } : { error: result });
  });
  socket.on('conference.policy.changed', async (raw: unknown, ack?: (value: unknown) => void) => {
    const session = await rooms.authenticate(room.code, String(socket.data.token ?? ''));
    if (!session || session.participant.id !== participant.id)
      return ack?.({ error: 'unauthorized' });
    const enabled = Boolean((raw as { enabled?: boolean })?.enabled);
    // Serialize the policy mutation with all other room mutations.  The
    // process-local policy cache is only changed after the durable CAS has
    // succeeded; otherwise a failed save can advertise a state token issuance
    // will (correctly) reject.
    try {
      let result: string = 'persistence_failed';
      await enqueue(room.code, async () => {
        const fresh = await rooms.get(room.code);
        if (!fresh || fresh.participants.get(participant.id)?.role !== 'host') {
          result = 'forbidden';
          return;
        }
        const expected = fresh.sequence;
        fresh.conferenceEnabled = enabled;
        fresh.sequence++;
        const persisted = await rooms.save(fresh, expected);
        if (!persisted) return;
        conferencePolicies.set(room.code, enabled);
        emitConferencePolicy(room.code);
        result = 'ok';
      });
      if (result === 'forbidden') return ack?.({ error: 'forbidden' });
      if (result !== 'ok') return ack?.({ error: 'persistence_failed' });
      return ack?.({ ok: true, enabled });
    } catch {
      return ack?.({ error: 'persistence_failed' });
    }
  });
  socket.on('conference.grant', async (raw: unknown, ack?: (value: unknown) => void) => {
    const session = await rooms.authenticate(room.code, String(socket.data.token ?? ''));
    if (!session || session.participant.id !== participant.id)
      return ack?.({ error: 'unauthorized' });
    const fresh = await rooms.get(room.code);
    const target = (raw as { participantId?: string })?.participantId;
    if (
      !fresh ||
      fresh.participants.get(participant.id)?.role !== 'host' ||
      !target ||
      !fresh.participants.has(target)
    )
      return ack?.({ error: 'forbidden' });
    const grants = conferenceGrants.get(room.code) ?? new Map();
    if (!grants.has(target) && grants.size >= 5) return ack?.({ error: 'publisher_limit' });
    grants.set(target, { canPublishAudio: true, canPublishVideo: true, canPublishScreen: true, canSubscribe: true });
    conferenceGrants.set(room.code, grants);
    await syncLiveKitGrant(room.code, target, grants.get(target)!);
    emitConferenceGrant(room.code, target);
    ack?.({ ok: true });
  });
  socket.on('conference.revoke', async (raw: unknown, ack?: (value: unknown) => void) => {
    const session = await rooms.authenticate(room.code, String(socket.data.token ?? ''));
    if (!session || session.participant.id !== participant.id)
      return ack?.({ error: 'unauthorized' });
    const result = await applyConferenceMutation(room.code, participant.id, (raw as { participantId?: string })?.participantId, 'revoke');
    return ack?.(result === 'ok' ? { ok: true } : { error: result });
  });
  socket.on('host.transfer', async (raw: unknown, ack?: (value: unknown) => void) => {
    const session = await rooms.authenticate(room.code, String(socket.data.token ?? ''));
    if (!session || session.participant.id !== participant.id)
      return ack?.({ error: 'unauthorized' });
    const target = (raw as { participantId?: string })?.participantId;
    const fresh = await rooms.get(room.code);
    if (
      !fresh ||
      fresh.participants.get(participant.id)?.role !== 'host' ||
      !target ||
      !fresh.participants.has(target)
    )
      return ack?.({ error: 'forbidden' });
    const saved = await commit(room.code, (r) => {
      if (r.participants.get(participant.id)?.role !== 'host' || !r.participants.has(target))
        return false;
      for (const p of r.participants.values()) p.role = p.id === target ? 'host' : 'viewer';
      r.sequence++;
      r.revision++;
    });
    if (saved) {
      broadcastParticipants(saved);
      emitRoom('host.transfer', { participantId: target });
      ack?.({ ok: true });
    } else ack?.({ error: 'conflict' });
  });
  socket.on('room.leave', () => socket.disconnect(true));
  socket.on('disconnect', () => {
    void enqueue(room.code, async () => {
      const connections = activeConnections.get(participant.id);
      connections?.delete(socket.id);
      const remaining = connections?.size ?? 0;
      if (remaining) activeConnections.set(participant.id, connections!);
      else activeConnections.delete(participant.id);
      const saved = await commit(room.code, (authoritative) => {
        const p = authoritative.participants.get(participant.id);
        if (!p) return;
        // A delayed disconnect from tab A must not mark tab B offline.
        p.online = remaining > 0;
        if (p.role === 'host' && remaining === 0) {
          const timer = setTimeout(
            () =>
              void enqueue(room.code, async () => {
                const latest = await rooms.get(room.code);
                if (!latest) return;
                const host = latest.participants.get(participant.id);
                if (!host || host.online) return;
                const nextHost = [...latest.participants.values()].find(
                  (candidate) => candidate.role === 'viewer' && candidate.online,
                );
                if (nextHost) {
                  host.role = 'viewer';
                  nextHost.role = 'host';
                  latest.sequence++;
                  latest.revision++;
                  await rooms.save(latest, latest.sequence - 1);
                  broadcastParticipants(latest);
                  emitRoom('host.transfer', { participantId: nextHost.id });
                } else {
                  latest.status = 'CLOSED';
                  latest.sequence++;
                  await rooms.save(latest, latest.sequence - 1);
                  emitRoom('room.closed', { reason: 'host_disconnected' });
                }
              }),
            30_000,
          );
          disconnectTimers.set(participant.id, timer);
        }
        authoritative.sequence++;
      });
      if (saved && saved !== null) broadcastParticipants(saved);
    }).catch((error: unknown) => {
      log('room_queue_error', {
        roomCode: room.code,
        error: error instanceof Error ? error.message : 'unknown',
      });
    });
  });
});

const port = Number(process.env.REALTIME_PORT ?? 4000);
if (process.env.NODE_ENV !== 'test')
  httpServer.listen(port, () => log('realtime_listening', { port }));
const shutdown = () => {
  io.close();
  httpServer.close(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
export { app, httpServer, io };
export * from './services/collaboration';
export * from './services/conference';
export * from './adapters';
