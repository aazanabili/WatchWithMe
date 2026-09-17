import { createHash, randomUUID } from 'node:crypto';

export const CHAT_TTL_SECONDS = 3 * 60 * 60;
export const CHAT_MAX_LENGTH = 2000;
const hasUnsafeControls = (value: string) =>
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
export type ChatMessage = {
  type: 'message';
  messageId: string;
  participantId: string;
  text: string;
  expiresAt: string;
  clientMessageId?: string;
};

/** Redis-compatible boundary. The in-memory implementation is deliberately deterministic for tests. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  lpush(key: string, value: string): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  expire(key: string, ttl: number): Promise<unknown>;
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly values = new Map<string, { value: string; expires: number }>();
  private readonly lists = new Map<string, string[]>();
  private readonly listExpiry = new Map<string, number>();
  private live(key: string) {
    const item = this.values.get(key);
    if (!item) return null;
    if (item.expires <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return item.value;
  }
  async get(key: string) {
    return this.live(key);
  }
  async set(key: string, value: string, _mode: 'EX', ttl: number) {
    if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('invalid_ttl');
    this.values.set(key, { value, expires: Date.now() + ttl * 1000 });
  }
  async del(key: string) {
    this.values.delete(key);
    this.lists.delete(key);
    this.listExpiry.delete(key);
  }
  async lpush(key: string, value: string) {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
  }
  async lrange(key: string, start: number, stop: number) {
    if ((this.listExpiry.get(key) ?? Infinity) <= Date.now()) {
      await this.del(key);
      return [];
    }
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop < 0 ? undefined : stop + 1);
  }
  async expire(key: string, ttl: number) {
    this.listExpiry.set(key, Date.now() + ttl * 1000);
  }
}

export class EphemeralChatStore {
  private readonly recent = new Map<string, number>();
  constructor(
    private readonly store: KeyValueStore,
    private readonly prefix = 'wwm:chat',
  ) {}
  private key(roomId: string) {
    return `${this.prefix}:${roomId}`;
  }
  async send(
    roomId: string,
    participantId: string,
    text: string,
    clientMessageId?: string,
    now = Date.now(),
  ): Promise<ChatMessage> {
    const clean = text.trim();
    if (
      !clean ||
      clean.length > CHAT_MAX_LENGTH ||
      hasUnsafeControls(clean) ||
      /<\s*\/?\s*[a-z][^>]*>/i.test(clean)
    )
      throw new Error('invalid_message');
    const dedupe = `${roomId}:${participantId}:${clientMessageId ?? randomUUID()}`;
    const previous = this.recent.get(dedupe);
    if (previous && now - previous < 2000) throw new Error('duplicate_message');
    this.recent.set(dedupe, now);
    if (this.recent.size > 10_000)
      for (const [key, at] of this.recent) if (now - at >= 2000) this.recent.delete(key);
    const message: ChatMessage = {
      type: 'message',
      messageId: randomUUID(),
      participantId,
      text: clean,
      expiresAt: new Date(now + CHAT_TTL_SECONDS * 1000).toISOString(),
      ...(clientMessageId ? { clientMessageId } : {}),
    };
    await this.store.lpush(this.key(roomId), JSON.stringify(message));
    // Refreshing the list TTL on every write gives the room a predictable three-hour history window.
    await this.store.expire(this.key(roomId), CHAT_TTL_SECONDS);
    return message;
  }
  async history(roomId: string, limit = 100): Promise<ChatMessage[]> {
    const raw = await this.store.lrange(this.key(roomId), 0, Math.max(0, Math.min(limit, 100) - 1));
    return raw.map((value) => JSON.parse(value) as ChatMessage).reverse();
  }
  async remove(roomId: string, messageId: string) {
    const messages = (await this.history(roomId)).filter((m) => m.messageId !== messageId);
    await this.store.del(this.key(roomId));
    for (const message of messages.reverse())
      await this.store.lpush(this.key(roomId), JSON.stringify(message));
    if (messages.length) await this.store.expire(this.key(roomId), CHAT_TTL_SECONDS);
  }
}

export type ObjectStore = {
  presignedPut(objectKey: string, contentType: string, expiresSeconds: number): Promise<string>;
  presignedGet(objectKey: string, expiresSeconds: number): Promise<string>;
};
export type MediaJob = {
  kind?: 'media' | 'subtitle';
  assetId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  roomId: string;
  subtitle?: { id: string; language: string; objectKey: string };
};
export interface MediaAssetStore {
  upsert(asset: {
    id: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    roomId: string;
    expiresAt: string;
  }): Promise<void>;
  get(id: string): Promise<Record<string, unknown> | undefined>;
  createSubtitle?(input: { id: string; assetId: string; language: string; format: 'VTT' | 'SRT'; objectKey: string }): Promise<void>;
  subtitles?(assetId: string): Promise<Array<Record<string, unknown>>>;
}
export class InMemoryMediaAssetStore implements MediaAssetStore {
  readonly assets = new Map<string, Record<string, unknown>>();
  readonly tracks = new Map<string, Record<string, unknown>>();
  async upsert(asset: {
    id: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    roomId: string;
    expiresAt: string;
  }) {
    this.assets.set(asset.id, { ...asset, durationSeconds: null, status: 'pending' });
  }
  async get(id: string) {
    return this.assets.get(id);
  }
  async createSubtitle(input: { id: string; assetId: string; language: string; format: 'VTT' | 'SRT'; objectKey: string }) { this.tracks.set(input.id, { ...input, status: 'PENDING' }); }
  async subtitles(assetId: string) { return [...this.tracks.values()].filter((track) => track.assetId === assetId); }
}
export const UPLOAD_MAX_BYTES = 2_000_000_000;
// Keep this association explicit: accepting a known extension and a known MIME
// independently would allow an attacker to pair a safe extension with another
// media type. The worker's ffprobe check remains the content-level defence.
const allowedMimeByExtension: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ts': 'video/mp2t',
  '.vtt': 'text/vtt',
  '.srt': 'application/x-subrip',
};
export function validateUpload(input: {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}) {
  const fileName = input.fileName.toLowerCase();
  const extension = `.${fileName.split('.').pop() ?? ''}`;
  if (
    input.fileName.length > 255 ||
    hasUnsafeControls(input.fileName) ||
    input.fileName.includes('/') ||
    input.fileName.includes('\\') ||
    input.fileName.includes('?') ||
    input.fileName.includes('#') ||
    input.fileName === '.' ||
    input.fileName === '..' ||
    input.fileName.split('.').includes('')
  )
    return false;
  return (
    input.sizeBytes > 0 &&
    input.sizeBytes <= UPLOAD_MAX_BYTES &&
    allowedMimeByExtension[extension] === input.contentType.toLowerCase()
  );
}

export class UploadService {
  constructor(
    private readonly objects: ObjectStore,
    private readonly expirySeconds = 3 * 3600,
  ) {}
  async intent(
    roomId: string,
    participantId: string,
    input: { fileName: string; contentType: string; sizeBytes: number },
    isHost: boolean,
  ) {
    if (!isHost || !validateUpload(input)) throw new Error('forbidden');
    const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `${roomId}/${randomUUID()}-${safeName}`;
    return {
      uploadId: randomUUID(),
      objectKey,
      participantId,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      expiresAt: new Date(Date.now() + this.expirySeconds * 1000).toISOString(),
      url: await this.objects.presignedPut(objectKey, input.contentType, this.expirySeconds),
    };
  }
  async playbackUrl(objectKey: string) {
    return this.objects.presignedGet(objectKey, 300);
  }
}

export function validateSubtitle(content: string, format: 'srt' | 'vtt') {
  if (content.length > 20_000_000) return false;
  if (/<[^>]*>|\b(?:https?|javascript|data):/i.test(content)) return false;
  if (format === 'vtt') return /^WEBVTT(?:\r?\n|$)/.test(content);
  return /(?:^|\r?\n)\d+\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+/.test(content);
}

export function normalizeProviderUrl(provider: string, value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error('invalid_media');
  const host = url.hostname.toLowerCase();
  const allowed: Record<string, string[]> = {
    youtube: ['youtube.com', 'www.youtube.com', 'youtu.be'],
    instagram: ['instagram.com', 'www.instagram.com'],
    tiktok: ['tiktok.com', 'www.tiktok.com'],
    vimeo: ['vimeo.com', 'www.vimeo.com'],
    dailymotion: ['dailymotion.com', 'www.dailymotion.com'],
    twitch: ['twitch.tv', 'www.twitch.tv'],
    facebook: ['facebook.com', 'www.facebook.com'],
  };
  if (provider !== 'mp4' && provider !== 'upload' && !(allowed[provider] ?? []).includes(host))
    throw new Error('invalid_media');
  if (
    (provider === 'mp4' || provider === 'upload') &&
    !/\.(mp4|webm)(?:$|\?)/i.test(url.pathname + url.search)
  )
    throw new Error('invalid_media');
  return url.toString();
}

export function dedupeKey(roomId: string, participantId: string, text: string) {
  return createHash('sha256').update(`${roomId}\0${participantId}\0${text.trim()}`).digest('hex');
}
