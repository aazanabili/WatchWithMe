export type PlayerCommand = { type: 'play' | 'pause' | 'seek'; positionSeconds?: number };
export interface PlayerAdapter {
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): void;
  getPosition(): number;
  destroy(): void;
  getDuration(): number | null;
  getBuffered(): number;
  onDuration(listener: (duration: number) => void): () => void;
  onReady(listener: () => void): () => void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  setReadOnly(readOnly: boolean): void;
  capabilities: { canPlay: boolean; canSeek: boolean; canSync: boolean };
}
export function makeHtmlAdapter(video: HTMLVideoElement): PlayerAdapter {
  const durationListeners = new Set<(duration: number) => void>();
  const readyListeners = new Set<() => void>();
  const onDuration = (event: Event) => {
    if (Number.isFinite(video.duration))
      durationListeners.forEach((listener) => listener(video.duration));
    void event;
  };
  const onReady = () => readyListeners.forEach((listener) => listener());
  video.addEventListener('durationchange', onDuration);
  video.addEventListener('loadedmetadata', onReady);
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
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('loadedmetadata', onReady);
    },
    getDuration: () => (Number.isFinite(video.duration) ? video.duration : null),
    getBuffered: () => {
      const range = video.buffered;
      return range.length ? range.end(range.length - 1) : 0;
    },
    onDuration: (listener) => {
      durationListeners.add(listener);
      return () => durationListeners.delete(listener);
    },
    onReady: (listener) => {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    setMuted: (muted) => {
      video.muted = muted;
    },
    setVolume: (volume) => {
      video.volume = Math.max(0, Math.min(1, volume));
    },
    setReadOnly: (readOnly) => {
      video.controls = !readOnly;
    },
    capabilities: { canPlay: true, canSeek: true, canSync: true },
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
