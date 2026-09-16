'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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
type Person = { id: string; role: 'host' | 'viewer' };
type Snap = {
  provider: 'youtube' | 'mp4';
  videoId: string;
  status: 'playing' | 'paused';
  positionSeconds: number;
  updatedAt: string;
};
declare global {
  interface Error {
    data?: { code?: string };
  }
}
export default function RoomClient({ roomId }: { roomId: string }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [connection, setConnection] = useState('connecting');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [ready, setReady] = useState(false);
  const [provider, setProvider] = useState<'youtube' | 'mp4'>('youtube');
  const [source, setSource] = useState('');
  const [credential, setCredential] = useState<{ token?: string; participantId?: string } | null>(
    null,
  );
  const [checked, setChecked] = useState(false);
  const socket = useRef<Socket | null>(null);
  const adapter = useRef<PlayerAdapter | null>(null);
  const redirecting = useRef(false);
  const router = useRouter();
  const send = useCallback((command: object) => {
    if (socket.current?.connected)
      socket.current.emit('command', { version: 'v1', commandId: crypto.randomUUID(), command });
  }, []);
  useEffect(() => {
    let alive = true;
    let saved: { token?: string; participantId?: string } | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(`watch-with-me:${roomId}`) || 'null');
    } catch {
      saved = null;
    }
    setCredential(saved);
    setChecked(true);
    const redirect = () => {
      if (redirecting.current) return;
      redirecting.current = true;
      sessionStorage.removeItem(`watch-with-me:${roomId}`);
      router.replace(`/join?room=${encodeURIComponent(roomId)}`);
    };
    if (!saved?.token) {
      redirect();
      return () => {
        alive = false;
      };
    }
    fetch(`${API}/rooms/${encodeURIComponent(roomId)}/state`, {
      headers: { Authorization: `Bearer ${saved.token}` },
    })
      .then((r) => {
        if ([401, 403, 404].includes(r.status)) {
          redirect();
          throw Error('redirected');
        }
        return r.ok ? r.json() : Promise.reject(Error('network'));
      })
      .then(async (d) => {
        if (!alive) return;
        setSnap(d.snapshot);
        setPeople(d.participants || []);
        const { io } = await import('socket.io-client');
        if (!alive) return;
        const s = io(SOCKET, { auth: { roomCode: roomId, token: saved?.token } });
        socket.current = s;
        s.io.on('reconnect_attempt', () => setConnection('reconnecting'));
        s.on('connect', () => {
          setConnection('connected');
          s.emit('command', {
            version: 'v1',
            commandId: crypto.randomUUID(),
            command: { type: 'request_state' },
          });
        })
          .on('disconnect', () => setConnection('disconnected'))
          .on('snapshot', (e) => {
            const x = e.data || e;
            setSnap(x.snapshot || x);
            if (Array.isArray(x.participants)) setPeople(x.participants);
          })
          .on('playback_changed', (e) => setSnap(e.data || e))
          .on('participants', (e) => {
            if (Array.isArray(e.data)) setPeople(e.data);
          })
          .on('unauthorized', redirect)
          .on('connect_error', (e) => {
            if (/unauthorized/i.test(e.message) || e.data?.code === 'UNAUTHORIZED') redirect();
            else {
              setConnection('disconnected');
              setError('تعذر الاتصال بالغرفة. سنحاول إعادة الاتصال.');
            }
          });
      })
      .catch((e) => {
        if (alive && e.message !== 'redirected') setError('تعذر تحميل حالة الغرفة.');
      });
    return () => {
      alive = false;
      socket.current?.removeAllListeners();
      socket.current?.disconnect();
      adapter.current?.destroy();
    };
  }, [roomId, router]);
  useEffect(() => {
    if (!snap || !adapter.current) return;
    const target = expectedPosition(snap.positionSeconds, snap.updatedAt, snap.status);
    if (Math.abs(adapter.current.getPosition() - target) > 0.75) adapter.current.seek(target);
    if (snap.status === 'playing') void adapter.current.play();
    else void adapter.current.pause();
  }, [snap]);
  function load() {
    const match = source
      .trim()
      .match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([^?&/]+)/);
    const id = provider === 'youtube' ? match?.[1] || source.trim() : source.trim();
    if (!id || (provider === 'mp4' && !/^https:\/\//i.test(id))) {
      setError('أدخل رابط مصدر صالحاً.');
      return;
    }
    setError('');
    setReady(false);
    send({ type: 'load', provider, videoId: id });
  }
  async function share() {
    const url = `${location.origin}/join?room=${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setFeedback('تم نسخ رابط الدعوة');
    } catch {
      setFeedback('تعذر النسخ — انسخ الرابط من شريط العنوان.');
    }
  }
  const isHost = Boolean(
    snap &&
    credential?.participantId &&
    people.some((p) => p.id === credential.participantId && p.role === 'host'),
  );
  const position = snap ? expectedPosition(snap.positionSeconds, snap.updatedAt, snap.status) : 0;
  if (!checked)
    return (
      <main className="room-shell">
        <p role="status" aria-live="polite">
          جاري التحقق من الدعوة…
        </p>
      </main>
    );
  if (!credential) return null;
  return (
    <main className="room-shell">
      <header className="room-nav">
        <a className="wordmark" href="/">
          WATCH <i>WITH</i> ME
        </a>
        <span className="status" role="status" aria-live="polite">
          <i className="dot" />{' '}
          {connection === 'connected'
            ? 'متصل ومتزامن'
            : connection === 'reconnecting'
              ? 'يعاد الاتصال…'
              : connection === 'disconnected'
                ? 'غير متصل'
                : 'جاري الاتصال…'}
        </span>
        <span className="kicker">ROOM / {roomId}</span>
      </header>
      <div className="room-grid">
        <section>
          <div
            className="stage"
            data-testid={snap?.provider === 'mp4' ? 'video-player' : undefined}
          >
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
                playsInline
                aria-label="مشغل الفيديو"
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
                value={provider}
                onChange={(e) => setProvider(e.target.value as 'youtube' | 'mp4')}
              >
                <option value="youtube">YouTube</option>
                <option value="mp4">MP4 مباشر</option>
              </select>
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                aria-label="رابط مصدر الفيديو"
                placeholder="https://…/movie.mp4"
              />
              <button onClick={load} disabled={connection !== 'connected'}>
                Load
              </button>
            </div>
          )}
          {isHost && (
            <div className="controls">
              <button onClick={() => send({ type: 'play' })} disabled={!ready} aria-label="تشغيل">
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
          {(error || feedback) && (
            <p role="status" aria-live="polite">
              {error || feedback}
            </p>
          )}
        </section>
        <aside className="room-side">
          <p className="kicker">الحاضرون / {people.length}</p>
          <ul className="participants" aria-live="polite">
            {people.map((p, i) => (
              <li key={p.id}>
                {i === 0 ? 'المضيف' : 'مشاهد'}{' '}
                <span className="role">{p.role === 'host' ? 'مضيف' : 'مشاهد'}</span>
              </li>
            ))}
          </ul>
          <button className="share" onClick={share}>
            انسخ رابط الدعوة
          </button>
        </aside>
      </div>
    </main>
  );
}
