'use client';
import { useMemo } from 'react';
import type { PlayerAdapter } from '../player-adapter';
export function useRoomPlayback(adapter: PlayerAdapter | null) {
  return useMemo(
    () => ({
      adapter,
      durationSeconds: adapter?.getDuration() ?? null,
      capabilities: adapter?.capabilities ?? null,
    }),
    [adapter],
  );
}
