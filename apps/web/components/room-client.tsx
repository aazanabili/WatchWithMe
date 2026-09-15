'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { PlayerAdapter } from './player-adapter';
import { expectedPosition } from './player-adapter';
const API = process.env.NEXT_PUBLIC_API_URL || '/api';
const SOCKET =
  process.env.NEXT_PUBLIC_SOCKET_URL ||
  process.env.NEXT_PUBLIC_REALTIME_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : API);
const YouTubePlayer = dynamic(() => import('./youtube-player'), { ssr: false });
type Snap = {
  provider: 'youtube' | 'mp4';
  videoId: string;
  status: 'playing' | 'paused';
  positionSeconds: number;
  updatedAt: string;
  revision: number;
};
type Person = { id: string; role: 'host' | 'viewer' };
function youtubeId(value: string) {
  const match = value.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([^?&/]+)/);
  return match?.[1] || (value.length === 11 ? value : '');
}
export default function RoomClient({ roomId }: { roomId: string }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [ready, setReady] = useState(false);
  const [provider, setProvider] = useState<'youtube' | 'mp4'>('youtube');
  const [source, setSource] = useState('');
  const adapter = useRef<PlayerAdapter | null>(null);
  const socket = useRef<Socket | null>(null);
  const [credential, setCredential] = useState<{ token?: string; role?: Person['role'] } | null>(
    null,
  );
  const send = useCallback(
    (command: object) =>
      socket.current?.emit('command', { version: 'v1', commandId: crypto.randomUUID(), command }),
    [],
  );
  useEffect(() => {
    let alive = true;
    let saved: { token?: string; role?: Person['role'] } | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(`watch-with-me:${roomId}`) || 'null');
    } catch {
      saved = null;
    }
    setCredential(saved);
    fetch(`${API}/rooms/${encodeURIComponent(roomId)}/state`, {
      headers: saved?.token ? { Authorization: `Bearer ${saved.token}` } : {},
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(async (d) => {
        if (!alive) return;
        setSnap(d.snapshot);
        setPeople(d.participants || []);
        const { io: connect } = await import('socket.io-client');
        if (!alive) return;
        const s = connect(SOCKET, { auth: { roomCode: roomId, token: saved?.token } });
        socket.current = s;
        s.on('connect', () => setConnected(true))
          .on('disconnect', () => setConnected(false))
          .on('snapshot', (e) => {
            const x = e.data || e;
            setSnap(x.snapshot || x);
            setPeople(x.participants || []);
          })
          .on('playback_changed', (e) => setSnap(e.data || e))
          .on('participants', (e) => setPeople(e.data || []))
          .on('command_rejected', (e) => setError(`لم يُنفذ الأمر: ${e.reason || 'رفض الخادم'}`))
          .on('connect_error', () => setError('الاتصال بالغرفة غير متاح حالياً.'));
      })
      .catch(() => {
        if (alive) setError('تعذر تحميل الغرفة. تحقق من الرابط.');
      });
    return () => {
      alive = false;
      socket.current?.disconnect();
      adapter.current?.destroy();
    };
  }, [roomId]);
  useEffect(() => {
    if (!snap || !adapter.current) return;
    const target = expectedPosition(snap.positionSeconds, snap.updatedAt, snap.status);
    if (Math.abs(adapter.current.getPosition() - target) > 0.75) adapter.current.seek(target);
    if (snap.status === 'playing') void adapter.current.play();
    else void adapter.current.pause();
  }, [snap]);
  function load() {
    const id = provider === 'youtube' ? youtubeId(source.trim()) : source.trim();
    if (!id || (provider === 'mp4' && !/^https:\/\//i.test(id)))
      return setError('أدخل رابط MP4 يبدأ بـ https://.');
    setError('');
    setReady(false);
    send({ type: 'load', provider, videoId: id });
  }
  function share() {
    void navigator.clipboard?.writeText(location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }
  const isHost = credential?.role === 'host';
  const position = snap ? expectedPosition(snap.positionSeconds, snap.updatedAt, snap.status) : 0;
  return (
    <main className="room-shell">
      <header className="room-nav">
        <a className="wordmark" href="/">
          WATCH <i>WITH</i> ME
        </a>
        <span className="status">
          <i className="dot" /> {connected ? 'متصل ومتزامن' : 'جاري الاتصال…'}
        </span>
        <span className="kicker">ROOM / {roomId}</span>
      </header>
      <div className="room-grid">
        <section>
          <div className="stage">
            {snap?.provider === 'mp4' ? (
              <video
                ref={(node) => {
                  if (node && !adapter.current)
                    import('./player-adapter').then((m) => {
                      adapter.current = m.makeHtmlAdapter(node);
                      setReady(true);
                    });
                }}
                src={snap.videoId}
                controls={isHost}
                playsInline
                aria-label="مشغل الفيديو"
                data-testid="video-player"
              />
            ) : snap?.provider === 'youtube' ? (
              <YouTubePlayer
                videoId={snap.videoId}
                onReady={(a) => {
                  adapter.current = a;
                  setReady(true);
                }}
              />
            ) : (
              <div className="stage-empty">
                <strong>الشاشة تنتظر العرض</strong>
                <span>سيظهر الفيديو هنا عندما يختاره المضيف.</span>
              </div>
            )}
          </div>
          {isHost && (
            <div className="host-tools">
              <label htmlFor="provider">مصدر الفيديو</label>
              <select
                id="provider"
                className="input"
                value={provider}
                onChange={(e) => setProvider(e.target.value as 'youtube' | 'mp4')}
              >
                <option value="youtube">YouTube</option>
                <option value="mp4">MP4 مباشر</option>
              </select>
              <input
                className="input"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="https://…/movie.mp4"
                aria-label="رابط مصدر الفيديو"
              />
              <button className="button button-primary" onClick={load} disabled={!connected}>
                Load
              </button>
            </div>
          )}
          {isHost && (
            <div className="controls">
              <button
                className="primary"
                onClick={() => send({ type: 'play' })}
                disabled={!ready}
                aria-label="تشغيل"
              >
                ▶
              </button>
              <button onClick={() => send({ type: 'pause' })} disabled={!ready} aria-label="إيقاف">
                Ⅱ
              </button>
              <input
                aria-label="التقديم في الفيديو"
                type="range"
                min="0"
                max="3600"
                value={Math.round(position)}
                onChange={(e) => send({ type: 'seek', positionSeconds: Number(e.target.value) })}
              />
            </div>
          )}
          {error && (
            <p className="error" aria-live="polite">
              {error}
            </p>
          )}
        </section>
        <aside className="room-side">
          <p className="kicker">الحاضرون / {people.length}</p>
          <h2>من في الغرفة؟</h2>
          <ul className="participants" aria-live="polite">
            {people.length ? (
              people.map((p, i) => (
                <li key={p.id}>
                  {i === 0 ? 'المضيف' : 'مشاهد'} <span className="role">{p.role}</span>
                </li>
              ))
            ) : (
              <li>بانتظار أول ضيف…</li>
            )}
          </ul>
          {isHost && <p className="live-note">أنت المضيف — اختر فيديو من أدوات الغرفة.</p>}
          <button className="share" onClick={share}>
            {copied ? 'تم نسخ الرابط ✓' : 'انسخ رابط الغرفة'}
          </button>
        </aside>
      </div>
    </main>
  );
}
