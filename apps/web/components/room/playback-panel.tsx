'use client';
import { useEffect, useRef, useState } from 'react';
import type { PlayerAdapter } from '../player-adapter';

const clock = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return '—:—';
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
export const shouldCommitRangeChange = (isDragging: boolean, isHost: boolean) => isHost && !isDragging;

export function PlaybackPanel({
  adapter,
  position,
  duration,
  isHost,
  onCommand,
  muted,
  onMute,
  volume,
  onVolume,
}: {
  adapter: PlayerAdapter | null;
  position: number;
  duration: number | null;
  isHost: boolean;
  onCommand: (command: { type: 'play' | 'pause' | 'seek'; positionSeconds?: number }) => void;
  muted: boolean;
  onMute: (value: boolean) => void;
  volume: number;
  onVolume: (value: number) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const shown = preview ?? position;
  const max = duration ?? 86400 * 365;
  const buffered = adapter && duration ? Math.min(adapter.getBuffered(), duration) : 0;
  useEffect(() => {
    if (!dragging) setPreview(null);
  }, [position, dragging]);
  const valueText = `${clock(shown)} من ${clock(duration)}${buffered ? `، تم التحميل حتى ${clock(buffered)}` : ''}${!isHost ? '، المشاهدة فقط' : ''}`;
  const commitSeek = (value: number) => {
    if (!isHost || !adapter) return;
    const next = Math.max(0, Math.min(value, duration ?? 86400 * 365));
    draggingRef.current = false;
    setDragging(false);
    setPreview(null);
    onCommand({ type: 'seek', positionSeconds: next });
  };
  return (
    <div
      className="controls"
      data-testid="playback-controls"
      role="group"
      aria-label="عناصر تحكم الفيديو"
    >
      {isHost && (
        <>
          <button
            type="button"
            onClick={() => onCommand({ type: 'play' })}
            disabled={!adapter}
            aria-label="تشغيل الفيديو"
            title="تشغيل الفيديو"
          >
            ▶
          </button>
          <button
            type="button"
            onClick={() => onCommand({ type: 'pause' })}
            disabled={!adapter}
            aria-label="إيقاف الفيديو"
            title="إيقاف الفيديو"
          >
            Ⅱ
          </button>
        </>
      )}
      <span aria-live="off">{clock(shown)}</span>
      <input
        aria-label="التقديم في الفيديو"
        aria-valuetext={valueText}
        type="range"
        min="0"
        max={max}
        step="0.1"
        value={Math.min(shown, max)}
        disabled={!isHost || !adapter}
        aria-disabled={!isHost || !adapter}
        onPointerDown={() => { if (isHost) { draggingRef.current = true; setDragging(true); } }}
        onChange={(e) => {
          if (!isHost) return;
          const next = Number(e.target.value);
          if (!Number.isFinite(next)) return;
          if (draggingRef.current) setPreview(next);
          else commitSeek(next);
        }}
        onPointerUp={(e) => { if (draggingRef.current) commitSeek(Number((e.target as HTMLInputElement).value)); }}
        onBlur={(e) => { if (draggingRef.current) commitSeek(Number(e.target.value)); }}
      />
       <span aria-label="مدة الفيديو">{clock(duration)}</span>
      <button
        type="button"
        onClick={() => onMute(!muted)}
        aria-pressed={muted}
        aria-label={muted ? 'إلغاء كتم صوت الفيديو' : 'كتم صوت الفيديو'}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <input
        aria-label="مستوى صوت الفيديو"
        aria-valuetext={`${Math.round(volume * 100)} بالمئة`}
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={volume}
        onChange={(e) => onVolume(Number(e.target.value))}
      />
    </div>
  );
}
