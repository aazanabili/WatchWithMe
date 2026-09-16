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
  ServerEvent,
} from '@watch-with-me/contracts';

type Participant = { id: string; role: 'host' | 'viewer' };
const MAX_CAS_RETRIES = 3;
export type StoredParticipant = Participant & {
  tokenHash: string;
  displayName: string;
  online: boolean;
};
export type Room = {
  code: string;
  participants: Map<string, StoredParticipant>;
  playback: PlaybackSnapshot | null;
  revision: number;
  sequence: number;
  commands: Map<string, number>;
};
export interface RoomRepository {
  create(room: Room): Promise<void>;
  get(code: string): Promise<Room | undefined>;
  save(room: Room, expectedSequence?: number): Promise<boolean>;
}
export class InMemoryRoomRepository implements RoomRepository {
  private readonly rooms = new Map<string, Room>();
  async create(room: Room) {
    this.rooms.set(room.code, room);
  }
  async get(code: string) {
    return this.rooms.get(code);
  }
  async save(room: Room): Promise<boolean> {
    this.rooms.set(room.code, room);
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
export function validateMedia(provider: 'youtube' | 'mp4', value: string): boolean {
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
      : new PrismaRoomRepository(),
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
      const expected = room.sequence;
      room.participants.set(p.id, p);
      if (await this.repo.save(room, expected)) return { room, token, participantId: p.id };
    }
    throw new Error('state_conflict');
  }
  async authenticate(roomCode: string, token: string) {
    const room = await this.repo.get(roomCode.toUpperCase());
    if (!room) return;
    const tokenHash = hash(token);
    for (const p of room.participants.values())
      if (same(p.tokenHash, tokenHash)) return { room, participant: p };
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
  snapshot(room: Room): Snapshot {
    return {
      version: CONTRACT_VERSION,
      roomId: room.code,
      snapshot: room.playback,
      participants: [...room.participants.values()].map(({ id, role }) => ({ id, role })),
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
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: now(), event, ...fields }));

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ error: message });
const httpBuckets = new Map<string, { at: number; count: number }>();
app.use('/api/rooms', (req, res, next) => {
  if (req.method === 'GET') return next();
  const key = req.ip ?? 'unknown';
  const bucket = httpBuckets.get(key) ?? { at: Date.now(), count: 0 };
  if (Date.now() - bucket.at >= 60_000) {
    bucket.at = Date.now();
    bucket.count = 0;
  }
  if (++bucket.count > 30) {
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
app.get('/health/ready', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/rooms/:code/state', async (req: Request, res: Response) => {
  // Do not reveal whether an arbitrary room code exists to unauthenticated callers.
  const auth = await rooms.authenticate(String(req.params.code), bearer(req));
  if (!auth) return fail(res, 401, 'unauthorized');
  return res.json(rooms.snapshot(auth.room));
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
  next();
});
const buckets = new WeakMap<object, { at: number; count: number }>();
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
const commit = async (roomCode: string, mutate: (room: Room) => void) => {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const authoritative = await rooms.get(roomCode);
    if (!authoritative) return undefined;
    const expected = authoritative.sequence;
    mutate(authoritative);
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
  socket.join(room.code);
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
      data: rooms.snapshot(saved),
    });
  }).catch((error: unknown) => {
    log('room_queue_error', {
      roomCode: room.code,
      error: error instanceof Error ? error.message : 'unknown',
    });
  });
  const handle = async (raw: unknown) =>
    enqueue(room.code, async (): Promise<void> => {
      const envelope = CommandEnvelope.safeParse(raw);
      if (!envelope.success) return emitError(socket, 'invalid_command');
      const fresh = await rooms.get(room.code);
      if (!fresh) return emitError(socket, 'room_not_found');
      Object.assign(room, fresh);
      const currentParticipant = room.participants.get(participant.id);
      if (!currentParticipant) return emitError(socket, 'unauthorized');
      const { commandId, command } = envelope.data;
      const bucket = buckets.get(socket) ?? { at: Date.now(), count: 0 };
      if (Date.now() - bucket.at > 1000) {
        bucket.at = Date.now();
        bucket.count = 0;
      }
      if (++bucket.count > 30) return emitError(socket, 'rate_limited', commandId);
      buckets.set(socket, bucket);
      if (room.commands.has(commandId)) {
        emitWire(socket, 'snapshot', {
          type: 'snapshot',
          eventId: randomUUID(),
          sequence: room.sequence,
          revision: room.revision,
          serverTime: now(),
          data: rooms.snapshot(room),
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
          data: rooms.snapshot(room),
        });
        return;
      }
      const loadCommand = command as Extract<Command, { type: 'load' }>;
      if (command.type === 'load' && !validateMedia(loadCommand.provider, loadCommand.videoId)) {
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
              videoId: loadCommand.videoId,
              status: 'paused',
              positionSeconds: 0,
              updatedAt: now(),
              revision: authoritative.revision + 1,
            };
          } else if (authoritative.playback) {
            const playback: PlaybackSnapshot = {
              ...authoritative.playback,
              updatedAt: now(),
              revision: authoritative.revision + 1,
            };
            if (command.type === 'play') playback.status = 'playing';
            else if (command.type === 'pause') playback.status = 'paused';
            else if (command.type === 'seek') playback.positionSeconds = command.positionSeconds;
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
          data: rooms.snapshot(result.room),
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
      emitWire(io.to(room.code), 'playback_changed', {
        type: 'playback_changed',
        eventId: randomUUID(),
        sequence: result.room.sequence,
        revision: result.room.revision,
        serverTime: now(),
        data: result.room.playback,
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
