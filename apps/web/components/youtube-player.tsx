'use client';
import { useEffect, useRef } from 'react';
import type { PlayerAdapter } from './player-adapter';
type YTPlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  mute: () => void;
  unMute: () => void;
  setVolume: (volume: number) => void;
  destroy: () => void;
};
type YTApi = {
  Player: new (
    element: HTMLElement,
    options: { videoId: string; events: { onReady: () => void } },
  ) => YTPlayer;
};

export default function YouTubePlayer({
  videoId,
  onReady,
}: {
  videoId: string;
  onReady: (adapter: PlayerAdapter) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    let player: YTPlayer | undefined;
    const yt = () => (window as Window & { YT?: YTApi }).YT;
    const init = () => {
      const api = yt();
      if (!ref.current || !api) return;
      player = new api.Player(ref.current, {
        videoId,
        events: {
          onReady: () =>
            onReadyRef.current({
              play: async () => {
                player?.playVideo();
              },
              pause: async () => {
                player?.pauseVideo();
              },
              seek: (s: number) => player?.seekTo(s, true),
              getPosition: () => player?.getCurrentTime() || 0,
              destroy: () => player?.destroy(),
              getDuration: () => player?.getDuration() || null,
              getBuffered: () => 0,
              onDuration: () => () => undefined,
              onReady: () => () => undefined,
              setMuted: (muted: boolean) => (muted ? player?.mute() : player?.unMute()),
              setVolume: (volume: number) => player?.setVolume(Math.round(volume * 100)),
              setReadOnly: () => undefined,
              capabilities: { canPlay: true, canSeek: true, canSync: true },
            }),
        },
      });
    };
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]',
    );
    if (!existing) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.body.appendChild(tag);
    }
    (window as Window & { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady = init;
    if (yt()?.Player) init();
    return () => {
      player?.destroy();
    };
  }, [videoId]);
  return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
}
