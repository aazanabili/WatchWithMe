import type {
  CommandEnvelope,
  PlaybackSnapshot,
  ServerEvent,
  Snapshot,
  VideoProvider,
} from '@watch-with-me/contracts';

export const DOMAIN_VERSION = 'v1' as const;

export type RoomLifecycle = 'waiting' | 'active' | 'closed';
export type RoomParticipant = Snapshot['participants'][number];

export interface RoomState {
  readonly roomId: string;
  readonly lifecycle: RoomLifecycle;
  readonly participants: readonly RoomParticipant[];
  readonly playback: PlaybackSnapshot | null;
  /** Revision is the state revision; sequence is the wire-event sequence. */
  readonly revision: number;
  readonly sequence: number;
  readonly commands: Map<string, TransitionResult>;
}

export interface TransitionContext {
  readonly actorId: string;
  readonly now: Date | string | number;
}

export interface TransitionResult {
  readonly state: RoomState;
  readonly event: ServerEvent;
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly reason?: string;
}

export function createRoomState(roomId: string, hostId: string): RoomState {
  if (!roomId.trim() || !hostId.trim()) throw new Error('roomId and hostId are required');
  return {
    roomId,
    lifecycle: 'waiting',
    participants: [{ id: hostId, role: 'host' }],
    playback: null,
    revision: 0,
    sequence: 0,
    commands: new Map(),
  };
}

export function addViewer(state: RoomState, id: string): RoomState {
  if (!id.trim() || state.lifecycle === 'closed' || state.participants.some((p) => p.id === id))
    return state;
  return { ...state, participants: [...state.participants, { id, role: 'viewer' }] };
}

export function removeParticipant(state: RoomState, id: string): RoomState {
  return { ...state, participants: state.participants.filter((p) => p.id !== id) };
}

export function closeRoom(state: RoomState): RoomState {
  if (state.lifecycle === 'closed') return state;
  return { ...state, lifecycle: 'closed', revision: state.revision + 1 };
}

export const createRoom = createRoomState;

function millis(value: Date | string | number): number {
  const result =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid timestamp');
  return result;
}

function position(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid position');
  return value;
}

function iso(value: Date | string | number): string {
  return new Date(millis(value)).toISOString();
}

function eventId(state: RoomState, commandId: string): string {
  return `${state.roomId}:${state.sequence + 1}:${commandId}`;
}

function snapshot(state: RoomState, now: string): Snapshot {
  return {
    version: DOMAIN_VERSION,
    roomId: state.roomId,
    snapshot: state.playback,
    participants: [...state.participants],
    sequence: state.sequence,
    serverTime: now,
  };
}

function reject(
  state: RoomState,
  envelope: CommandEnvelope,
  now: string,
  reason: string,
): TransitionResult {
  const nextSequence = state.sequence + 1;
  const event: ServerEvent = {
    type: 'command_rejected',
    eventId: eventId(state, envelope.commandId),
    commandId: envelope.commandId,
    sequence: nextSequence,
    serverTime: now,
    reason,
  };
  const next = { ...state, sequence: nextSequence, commands: new Map(state.commands) };
  const result = { state: next, event, accepted: false, duplicate: false, reason };
  next.commands.set(envelope.commandId, result);
  return result;
}

/** Applies one command. The caller supplies server time; no wall clock is read here. */
export function transition(
  state: RoomState,
  envelope: CommandEnvelope,
  context: TransitionContext,
): TransitionResult {
  if (envelope.version !== DOMAIN_VERSION || !envelope.commandId.trim()) {
    throw new Error('Invalid command envelope');
  }
  const prior = state.commands.get(envelope.commandId);
  if (prior) return { ...prior, duplicate: true };
  const now = iso(context.now);
  const actor = state.participants.find((p) => p.id === context.actorId);
  if (!actor) return reject(state, envelope, now, 'participant_not_found');
  if (state.lifecycle === 'closed') return reject(state, envelope, now, 'room_closed');
  if (actor.role === 'viewer' && envelope.command.type !== 'request_state')
    return reject(state, envelope, now, 'viewer_controls_forbidden');

  if (envelope.command.type === 'request_state') {
    const sequence = state.sequence + 1;
    const event: ServerEvent = {
      type: 'snapshot',
      eventId: eventId(state, envelope.commandId),
      sequence,
      serverTime: now,
      data: snapshot({ ...state, sequence }, now),
    };
    const next = { ...state, sequence, commands: new Map(state.commands) };
    const result = { state: next, event, accepted: true, duplicate: false };
    next.commands.set(envelope.commandId, result);
    return result;
  }

  const command = envelope.command;
  let playback: PlaybackSnapshot | null = state.playback;
  if (command.type === 'load') {
    if (!command.videoId.trim()) throw new Error('Invalid video id');
    playback = {
      provider: command.provider,
      videoId: command.videoId,
      status: 'paused',
      positionSeconds: 0,
      updatedAt: now,
    };
  } else if (!playback) return reject(state, envelope, now, 'no_media_loaded');
  else if (command.type === 'play' || command.type === 'pause') {
    const positionSeconds = expectedPosition(playback, millis(context.now));
    playback = {
      ...playback,
      status: command.type === 'play' ? 'playing' : 'paused',
      positionSeconds,
      updatedAt: now,
    };
  } else if (command.type === 'seek')
    playback = { ...playback, positionSeconds: position(command.positionSeconds), updatedAt: now };

  const sequence = state.sequence + 1;
  const next: RoomState = {
    ...state,
    lifecycle: 'active',
    playback,
    revision: state.revision + 1,
    sequence,
    commands: new Map(state.commands),
  };
  const event: ServerEvent = {
    type: 'playback_changed',
    eventId: eventId(state, envelope.commandId),
    sequence,
    serverTime: now,
    data: playback,
  };
  const result = { state: next, event, accepted: true, duplicate: false };
  next.commands.set(envelope.commandId, result);
  return result;
}

export const applyCommand = transition;
export const transitionRoom = transition;

export function load(
  state: RoomState,
  context: TransitionContext,
  provider: VideoProvider,
  videoId: string,
  commandId: string,
): TransitionResult {
  return transition(
    state,
    { version: DOMAIN_VERSION, commandId, command: { type: 'load', provider, videoId } },
    context,
  );
}
export function play(
  state: RoomState,
  context: TransitionContext,
  commandId: string,
): TransitionResult {
  return transition(
    state,
    { version: DOMAIN_VERSION, commandId, command: { type: 'play' } },
    context,
  );
}
export function pause(
  state: RoomState,
  context: TransitionContext,
  commandId: string,
): TransitionResult {
  return transition(
    state,
    { version: DOMAIN_VERSION, commandId, command: { type: 'pause' } },
    context,
  );
}
export function seek(
  state: RoomState,
  context: TransitionContext,
  positionSeconds: number,
  commandId: string,
): TransitionResult {
  return transition(
    state,
    { version: DOMAIN_VERSION, commandId, command: { type: 'seek', positionSeconds } },
    context,
  );
}

export function expectedPosition(
  playback: PlaybackSnapshot,
  serverNow: Date | string | number,
): number {
  if (playback.status === 'paused') return playback.positionSeconds;
  return Math.max(
    0,
    playback.positionSeconds + Math.max(0, (millis(serverNow) - millis(playback.updatedAt)) / 1000),
  );
}
export const calculateExpectedPosition = expectedPosition;

export interface ClockSample {
  clientSentAt: number;
  serverReceivedAt: number;
  clientReceivedAt: number;
}
/** NTP-style offset: positive means the server clock is ahead of the client. */
export function clockOffset(sample: ClockSample): number {
  return (
    sample.serverReceivedAt -
    (sample.clientSentAt + (sample.clientReceivedAt - sample.clientSentAt) / 2)
  );
}
export const estimateClockOffset = clockOffset;

export type DriftClass = 'synced' | 'minor' | 'major';
export interface DriftPolicy {
  minorThresholdSeconds: number;
  majorThresholdSeconds: number;
  hysteresisSeconds: number;
  softCorrectionMaxSeconds: number;
}
export const DEFAULT_DRIFT_POLICY: DriftPolicy = {
  minorThresholdSeconds: 0.25,
  majorThresholdSeconds: 1.5,
  hysteresisSeconds: 0.1,
  softCorrectionMaxSeconds: 0.5,
};

export function classifyDrift(
  driftSeconds: number,
  previous: DriftClass = 'synced',
  policy: DriftPolicy = DEFAULT_DRIFT_POLICY,
): DriftClass {
  const magnitude = Math.abs(driftSeconds);
  const hysteresis = previous === 'synced' ? 0 : policy.hysteresisSeconds;
  if (magnitude >= policy.majorThresholdSeconds + hysteresis) return 'major';
  if (magnitude >= policy.minorThresholdSeconds + hysteresis) return 'minor';
  if (previous === 'major' && magnitude >= policy.majorThresholdSeconds - policy.hysteresisSeconds)
    return 'major';
  if (previous !== 'synced' && magnitude >= policy.minorThresholdSeconds - policy.hysteresisSeconds)
    return 'minor';
  return 'synced';
}

export type CorrectionAction = 'none' | 'soft_seek' | 'hard_seek';
export function correctionPolicy(
  driftSeconds: number,
  policy: DriftPolicy = DEFAULT_DRIFT_POLICY,
): CorrectionAction {
  const magnitude = Math.abs(driftSeconds);
  if (magnitude >= policy.majorThresholdSeconds) return 'hard_seek';
  if (magnitude >= policy.minorThresholdSeconds && magnitude <= policy.softCorrectionMaxSeconds)
    return 'soft_seek';
  return 'none';
}

export const getCorrectionPolicy = correctionPolicy;

/** Consumers can use this guard before applying events arriving out of order. */
export function isStaleEvent(event: Pick<ServerEvent, 'sequence'>, lastSequence: number): boolean {
  return event.sequence <= lastSequence;
}

export function hasProcessedCommand(state: RoomState, commandId: string): boolean {
  return state.commands.has(commandId);
}
