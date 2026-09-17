'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Socket } from 'socket.io-client';
import type { PlayerAdapter } from './player-adapter';
import { expectedPosition } from './player-adapter';
import { PlaybackPanel } from './room/playback-panel';
import { ChatPanel } from './room/chat-panel';
import { ConferencePanel } from './room/conference-panel';
import { UploadPanel } from './room/upload-panel';
import { SubtitlePanel, parseWebVtt } from './room/subtitle-panel';
const API = process.env.NEXT_PUBLIC_API_URL || '/api';
const SOCKET =
  process.env.NEXT_PUBLIC_SOCKET_URL ||
  process.env.NEXT_PUBLIC_REALTIME_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : API);
const YouTubePlayer = dynamic(() => import('./youtube-player'), { ssr: false });
type Person = { id: string; role: 'host' | 'viewer' };
type Provider = Snap['provider'];
type Snap = {
  provider:
    | 'youtube'
    | 'mp4'
    | 'upload'
    | 'instagram'
    | 'tiktok'
    | 'vimeo'
    | 'dailymotion'
    | 'twitch'
    | 'facebook';
  videoId: string;
  status: 'playing' | 'paused';
  positionSeconds: number;
  updatedAt: string;
  revision: number;
  durationSeconds?: number | null;
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
  const [provider, setProvider] = useState<Provider>('youtube');
  const [source, setSource] = useState('');
  const [credential, setCredential] = useState<{ token?: string } | null>(null);
  const [currentParticipant, setCurrentParticipant] = useState<Person | null>(null);
  const [checked, setChecked] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [assetId, setAssetId] = useState<string>();
  const [subtitle, setSubtitle] = useState<{ src: string; language: string; text: string | null }>();
  const [captionsOn, setCaptionsOn] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const subtitleBlobRef = useRef<string | null>(null);
  const socket = useRef<Socket | null>(null);
  const [liveSocket, setLiveSocket] = useState<Socket | null>(null);
  const adapter = useRef<PlayerAdapter | null>(null);
  const redirecting = useRef(false);
  const router = useRouter();
  const send = useCallback((command: object) => {
    if (socket.current?.connected)
      socket.current.emit('command', { version: 'v1', commandId: crypto.randomUUID(), command });
  }, []);
  useEffect(() => {
    let alive = true;
    let saved: { token?: string } | null = null;
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
        setCurrentParticipant(d.currentParticipant);
        const { io } = await import('socket.io-client');
        if (!alive) return;
        const s = io(SOCKET, { auth: { roomCode: roomId, token: saved?.token } });
        socket.current = s;
        setLiveSocket(s);
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
            if (x.currentParticipant) setCurrentParticipant(x.currentParticipant);
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
      setLiveSocket(null);
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
  useEffect(() => {
    if (subtitleBlobRef.current?.startsWith('blob:')) URL.revokeObjectURL(subtitleBlobRef.current);
    subtitleBlobRef.current = null;
    setSubtitle(undefined);
    setCaptionsOn(false);
    adapter.current?.destroy();
    adapter.current = null;
    setReady(false);
    return () => { adapter.current?.destroy(); adapter.current = null; };
  }, [snap?.provider, snap?.videoId]);
  useEffect(() => () => { if (subtitleBlobRef.current?.startsWith('blob:')) URL.revokeObjectURL(subtitleBlobRef.current); }, []);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || (snap?.provider !== 'mp4' && snap?.provider !== 'upload')) return;
    let disposed = false;
    import('./player-adapter').then(m => { if (!disposed && videoRef.current === video) { adapter.current = m.makeHtmlAdapter(video); adapter.current.setReadOnly(true); setReady(true); } });
    return () => { disposed = true; };
  }, [snap?.provider, snap?.videoId]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !subtitle) return;
    const applyMode = () => { const track = video.textTracks[0]; if (track) track.mode = captionsOn ? 'showing' : 'disabled'; };
    video.addEventListener('loadedmetadata', applyMode); video.textTracks[0]?.addEventListener('load', applyMode);
    applyMode(); return () => { video.removeEventListener('loadedmetadata', applyMode); video.textTracks[0]?.removeEventListener('load', applyMode); };
  }, [subtitle, captionsOn]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !subtitle?.text) return;
    const textTrack = video.addTextTrack('subtitles', subtitle.language, subtitle.language);
    const cues = parseWebVtt(subtitle.text).map(cue => new VTTCue(cue.startTime, cue.endTime, cue.text));
    cues.forEach(cue => textTrack.addCue(cue)); textTrack.mode = captionsOn ? 'showing' : 'disabled';
    return () => { for (const cue of Array.from(textTrack.cues ?? [])) textTrack.removeCue(cue); textTrack.mode = 'disabled'; };
  }, [subtitle, captionsOn]);
  useEffect(() => {
    const a = adapter.current;
    if (!a) return;
    setDuration(a.getDuration());
    return a.onDuration(setDuration);
  }, [ready, snap?.videoId]);
  useEffect(() => {
    adapter.current?.setMuted(muted);
  }, [muted, ready]);
  useEffect(() => {
    adapter.current?.setVolume(volume);
  }, [volume, ready]);
  function load() {
    const match = source
      .trim()
      .match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([^?&/]+)/);
    const id = provider === 'youtube' ? match?.[1] || source.trim() : source.trim();
    if (!id || (provider !== 'youtube' && !/^https:\/\//i.test(id))) {
      setError('أدخل رابط مصدر صالحاً.');
      return;
    }
    setError('');
    setReady(false);
    send({ type: 'load', provider, videoId: id, durationSeconds: null });
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
  const isHost = currentParticipant?.role === 'host';
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
  const viewOnly = ['instagram', 'tiktok', 'vimeo', 'dailymotion', 'twitch', 'facebook'].includes(
    snap?.provider || '',
  );
  const embed =
    snap?.provider === 'youtube'
      ? `https://www.youtube.com/embed/${encodeURIComponent(snap.videoId)}`
      : snap?.provider === 'vimeo'
        ? `https://player.vimeo.com/video/${encodeURIComponent(snap.videoId)}`
        : snap?.provider
          ? `https://www.${snap.provider}.com/`
          : '';
  const leave = () => {
    socket.current?.emit('room.leave');
    socket.current?.disconnect();
    adapter.current?.destroy();
    sessionStorage.removeItem(`watch-with-me:${roomId}`);
    router.replace('/');
  };
  return (
    <main className="room-shell">
      <header className="room-nav">
        <a className="wordmark" href="/" aria-label="العودة إلى الصفحة الرئيسية">
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
        <span className="kicker">WATCH PARTY</span>
      </header>
      <div className="room-grid">
        <section>
          <div
            className="stage"
             data-testid={snap?.provider === 'mp4' || snap?.provider === 'upload' ? 'video-player' : undefined}
          >
            {snap?.provider === 'mp4' || snap?.provider === 'upload' ? (
              <video
                ref={videoRef}
                key={`${snap.provider}:${snap.videoId}`}
                src={snap.videoId}
                crossOrigin="anonymous"
                playsInline
                controls={false}
                aria-label="مشغل الفيديو"
                aria-describedby="video-disclosure"
              >
                {subtitle && !subtitle.text && (
                  <track
                    kind="subtitles"
                    src={subtitle.src}
                    srcLang={subtitle.language}
                    label={subtitle.language}
                    key={`${subtitle.src}:${subtitle.language}`}
                    default={captionsOn}
                    onError={() => setError('تعذر تحميل ملف الترجمة الموقّع.')}
                  />
                )}
              </video>
            ) : snap?.provider === 'youtube' ? (
              <YouTubePlayer
                videoId={snap.videoId}
                onReady={(a) => {
                  adapter.current = a;
                  setReady(true);
                }}
              />
            ) : viewOnly ? (
              <iframe
                title={`${snap?.provider ?? 'external'} view-only embed`}
                src={embed}
                allow="autoplay; fullscreen"
                onError={() => setError('تعذر تحميل هذا المصدر الخارجي.')}
              />
            ) : (
              <div className="stage-empty">
                <strong>الشاشة تنتظر العرض</strong>
                <span>سيظهر الفيديو هنا عندما يختاره المضيف.</span>
              </div>
            )}
          </div>
          <p id="video-disclosure" className="live-note">
            {viewOnly
              ? `هذا مصدر ${snap?.provider} خارجي للعرض فقط؛ لا تتوفر مزامنة أو تحكم من الغرفة.`
              : isHost
                ? 'أنت المضيف ويمكنك التحكم بالتشغيل.'
                : 'المشاهدة متاحة للجميع؛ يتحكم المضيف بالتشغيل.'}
          </p>
          {isHost && (
            <div className="host-tools">
              <label htmlFor="provider">مصدر الفيديو</label>
              <select
                id="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
              >
                <option value="youtube">YouTube</option>
                <option value="mp4">MP4 مباشر</option>
                <option value="instagram">Instagram (عرض فقط)</option>
                <option value="tiktok">TikTok (عرض فقط)</option>
                <option value="vimeo">Vimeo (عرض فقط)</option>
                <option value="dailymotion">Dailymotion (عرض فقط)</option>
                <option value="twitch">Twitch (عرض فقط)</option>
                <option value="facebook">Facebook (عرض فقط)</option>
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
              {credential.token && (
                <UploadPanel
                  api={API}
                  roomId={roomId}
                  token={credential.token}
              onLoaded={(url, id, uploadedDuration) => {
                setAssetId(id);
                setDuration(uploadedDuration);
                setProvider('mp4');
                setSource(url);
                send({ type: 'load', provider: 'upload', videoId: url, durationSeconds: uploadedDuration });
              }}
                />
              )}
              {credential.token && (
                <SubtitlePanel
                  api={API}
                  roomId={roomId}
                  token={credential.token}
                  assetId={assetId}
              onLoaded={(src, language, text) => {
                    if (subtitleBlobRef.current?.startsWith('blob:')) URL.revokeObjectURL(subtitleBlobRef.current);
                    subtitleBlobRef.current = src.startsWith('blob:') ? src : null;
                    setSubtitle({ src, language, text });
                    setCaptionsOn(true);
                  }}
                />
              )}
            </div>
          )}
          {!viewOnly && isHost && (
            <PlaybackPanel
              adapter={adapter.current}
              position={position}
              duration={duration ?? snap?.durationSeconds ?? null}
              isHost={Boolean(isHost)}
              onCommand={
                send as (c: { type: 'play' | 'pause' | 'seek'; positionSeconds?: number }) => void
              }
              muted={muted}
              onMute={setMuted}
              volume={volume}
              onVolume={(v) => {
                setVolume(v);
                if (v > 0) setMuted(false);
              }}
            />
          )}
          {subtitle && (
            <label className="caption-toggle">
              <input
                type="checkbox"
                checked={captionsOn}
                onChange={(e) => setCaptionsOn(e.target.checked)}
              />{' '}
              الترجمة: {subtitle.language} / {captionsOn ? 'تشغيل' : 'إيقاف'}
            </label>
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
                {i === 0 ? 'المضيف' : `مشاهد ${i + 1}`}{' '}
                <span className="role">{p.role === 'host' ? 'مضيف' : 'مشاهد'}</span>
              </li>
            ))}
          </ul>
          <button className="share" onClick={share}>
            انسخ رابط الدعوة
          </button>
          {isHost && people.filter((p) => p.role === 'viewer').length > 0 && (
            <label className="label" htmlFor="transfer">
              نقل الاستضافة
              <select
                id="transfer"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value && window.confirm('هل تريد نقل الاستضافة إلى هذا المشاهد؟'))
                    socket.current?.emit('host.transfer', { participantId: e.target.value });
                }}
              >
                <option value="">اختر مشاهداً</option>
                {people
                  .filter((p) => p.role === 'viewer')
                  .map((p, i) => (
                    <option key={p.id} value={p.id}>
                      مشاهد {i + 1}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <button
            className="share"
            onClick={() => {
              if (window.confirm('هل تريد مغادرة الغرفة؟')) leave();
            }}
          >
            مغادرة الغرفة
          </button>
          <ChatPanel
            socket={liveSocket}
            isHost={Boolean(isHost)}
            participantId={currentParticipant?.id}
          />
          <ConferencePanel
            socket={liveSocket}
            tokenUrl={`${API}/rooms/${encodeURIComponent(roomId)}/conference/token`}
            token={credential.token || ''}
            currentParticipant={currentParticipant}
            participants={people}
          />
        </aside>
      </div>
    </main>
  );
}
