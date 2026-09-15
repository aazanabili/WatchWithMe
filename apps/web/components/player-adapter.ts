export type PlayerCommand = { type: 'play' | 'pause' | 'seek'; positionSeconds?: number };
export interface PlayerAdapter {
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): void;
  getPosition(): number;
  destroy(): void;
}
export function makeHtmlAdapter(video: HTMLVideoElement): PlayerAdapter {
  return {
    play: () => video.play(),
    pause: () => {
      video.pause();
      return Promise.resolve();
    },
    seek: (s) => {
      video.currentTime = s;
    },
    getPosition: () => video.currentTime || 0,
    destroy: () => {
      video.pause();
    },
  };
}
export function expectedPosition(
  position: number,
  updatedAt: string,
  status: 'playing' | 'paused',
  now = Date.now(),
) {
  return Math.max(
    0,
    position + (status === 'playing' ? Math.max(0, now - Date.parse(updatedAt)) / 1000 : 0),
  );
}
