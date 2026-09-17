import { describe, expect, it } from 'vitest';
import type { ParticipantRole } from '@watch-with-me/database';
import type { MediaProvider } from '@watch-with-me/database';
import {
  mapMediaProvider,
  mapParticipantRole,
  type DomainMediaProvider,
  type DomainParticipantRole,
} from './prisma-room-repository';

describe('Prisma participant role mapping', () => {
  it.each([
    ['GUEST', 'viewer'],
    ['HOST', 'host'],
  ] as const)('maps persisted %s to domain %s', (persisted, domain) => {
    expect(mapParticipantRole(persisted as ParticipantRole)).toBe(domain);
  });

  it.each([
    ['viewer', 'GUEST'],
    ['host', 'HOST'],
  ] as const)('maps domain %s to persisted %s', (domain, persisted) => {
    expect(mapParticipantRole(domain as DomainParticipantRole)).toBe(persisted);
  });

  it.each(['HOST', 'GUEST'] as const)('round-trips persisted %s', (persisted) => {
    expect(mapParticipantRole(mapParticipantRole(persisted))).toBe(persisted);
  });

  it.each(['host', 'viewer'] as const)('round-trips domain %s', (domain) => {
    expect(mapParticipantRole(mapParticipantRole(domain))).toBe(domain);
  });
});

describe('Prisma media provider mapping', () => {
  it.each([
    ['YOUTUBE', 'youtube'],
    ['CUSTOM', 'mp4'],
  ] as const)('maps persisted snapshot provider %s to contract %s', (persisted, contract) => {
    expect(mapMediaProvider(persisted as MediaProvider)).toBe(contract);
  });

  it.each([
    ['youtube', 'YOUTUBE'],
    ['mp4', 'MP4'],
  ] as const)('maps contract provider %s to persisted %s', (contract, persisted) => {
    expect(mapMediaProvider(contract as DomainMediaProvider)).toBe(persisted);
  });

  it.each(['YOUTUBE', 'MP4'] as const)(
    'round-trips persisted snapshot provider %s',
    (persisted) => {
      expect(mapMediaProvider(mapMediaProvider(persisted))).toBe(persisted);
    },
  );

  it.each(['youtube', 'mp4'] as const)('round-trips contract provider %s', (contract) => {
    expect(mapMediaProvider(mapMediaProvider(contract))).toBe(contract);
  });
});
