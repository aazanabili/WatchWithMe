import { z } from 'zod';
import { MediaProvider, SyncMode } from './media';

export const CONTRACT_VERSION = 'v1' as const;
export const RoomRole = z.enum(['host', 'viewer']);
export type RoomRole = z.infer<typeof RoomRole>;
export const PlaybackStatus = z.enum(['playing', 'paused']);
export type PlaybackStatus = z.infer<typeof PlaybackStatus>;
export const VideoProvider = MediaProvider;
export type VideoProvider = z.infer<typeof VideoProvider>;

export const PlaybackSnapshot = z
  .object({
    provider: VideoProvider,
    videoId: z.string().trim().min(1).max(2048),
    status: PlaybackStatus,
    positionSeconds: z.number().nonnegative(),
    durationSeconds: z.number().finite().nonnegative().nullable(),
    syncMode: SyncMode.optional(),
    updatedAt: z.string().datetime(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type PlaybackSnapshot = z.infer<typeof PlaybackSnapshot>;
export const Participant = z.object({ id: z.string().min(1).max(128), role: RoomRole }).strict();
export const Snapshot = z
  .object({
    version: z.literal(CONTRACT_VERSION),
    roomId: z.string().min(1),
    snapshot: PlaybackSnapshot.nullable(),
    participants: z.array(Participant),
    // Domain-only snapshots may omit transport identity; authenticated HTTP/socket snapshots include it.
    currentParticipant: Participant.optional(),
    sequence: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    serverTime: z.string().datetime(),
  })
  .strict();
export type Snapshot = z.infer<typeof Snapshot>;

export const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play') }).strict(),
  z.object({ type: z.literal('pause') }).strict(),
  z
    .object({
      type: z.literal('seek'),
      positionSeconds: z
        .number()
        .finite()
        .nonnegative()
        .max(86400 * 365),
    })
    .strict(),
  z
    .object({
      type: z.literal('load'),
      provider: VideoProvider,
      videoId: z.string().trim().min(1).max(2048),
      durationSeconds: z.number().finite().nonnegative().nullable(),
      syncMode: SyncMode.optional(),
    })
    .strict(),
  z.object({ type: z.literal('request_state') }).strict(),
]);
export type Command = z.infer<typeof Command>;
export const CommandEnvelope = z
  .object({
    version: z.literal(CONTRACT_VERSION),
    commandId: z.string().trim().min(1).max(128),
    command: Command,
  })
  .strict();
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    eventId: z.string(),
    sequence: z.number(),
    revision: z.number().int().nonnegative(),
    serverTime: z.string().datetime(),
    data: Snapshot,
  }),
  z.object({
    type: z.literal('playback_changed'),
    eventId: z.string(),
    sequence: z.number(),
    revision: z.number().int().nonnegative(),
    serverTime: z.string().datetime(),
    data: PlaybackSnapshot,
  }),
  z.object({
    type: z.literal('participants'),
    eventId: z.string(),
    sequence: z.number(),
    revision: z.number().int().nonnegative(),
    serverTime: z.string().datetime(),
    data: z.array(Participant),
  }),
  z.object({
    type: z.literal('command_rejected'),
    eventId: z.string(),
    commandId: z.string(),
    sequence: z.number(),
    revision: z.number().int().nonnegative(),
    serverTime: z.string().datetime(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    eventId: z.string(),
    sequence: z.number(),
    revision: z.number().int().nonnegative(),
    serverTime: z.string().datetime(),
    message: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

// HTTP DTOs are versioned alongside socket contracts so transport adapters remain thin.
export const CreateRoomRequest = z
  .object({
    displayName: z.string().trim().min(1).max(80),
  })
  .strict();
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;
export const CreateRoomResponse = z.object({
  version: z.literal(CONTRACT_VERSION),
  roomId: z.string().min(1),
  roomCode: z.string().min(1),
  token: z.string().min(1),
  participantId: z.string().min(1),
  role: RoomRole,
  serverTime: z.string().datetime(),
});
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;
export const JoinRoomRequest = z
  .object({
    roomId: z.string().trim().min(1).max(32),
    displayName: z.string().trim().min(1).max(80),
  })
  .strict();
export type JoinRoomRequest = z.infer<typeof JoinRoomRequest>;

export * from './media';
export * from './room';
export * from './chat';
export * from './conference';
export * from './upload';
