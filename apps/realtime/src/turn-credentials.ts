import { createHmac } from 'node:crypto';

export type TurnIceServer = { urls: string[]; username: string; credential: string };

export function createTurnIceServer(input: { participantId: string; expiresAt: string; secret: string; url: string; maxTtlSeconds?: number; nowMs?: number }): TurnIceServer {
  if (!input.secret || !input.participantId || !input.url) throw new Error('invalid_turn_configuration');
  const expiry = Math.floor(Date.parse(input.expiresAt) / 1000);
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const ttl = Math.min(input.maxTtlSeconds ?? 300, expiry - now);
  if (!Number.isInteger(expiry) || ttl <= 0) throw new Error('turn_credential_expired');
  const username = `${now + ttl}:${input.participantId}`;
  const credential = createHmac('sha1', input.secret).update(username).digest('base64');
  return { urls: [input.url], username, credential };
}
