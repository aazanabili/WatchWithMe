'use client';
import Link from 'next/link';
import { useState } from 'react';
const API = process.env.NEXT_PUBLIC_API_URL || '/api';
export default function JoinForm() {
  const [roomId, setRoomId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!roomId.trim() || !name.trim()) return setError('أكمل رمز الغرفة واسمك.');
    setBusy(true);
    try {
      const id = roomId.trim();
      const r = await fetch(`${API}/rooms/${encodeURIComponent(id)}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: id, displayName: name.trim() }),
      });
      if (!r.ok) throw Error();
      location.href = `/room/${encodeURIComponent(id)}`;
    } catch {
      setError('لم نجد هذه الغرفة. تحقق من الرابط.');
      setBusy(false);
    }
  }
  return (
    <main className="form-page">
      <form
        className="form-card"
        onSubmit={submit}
        aria-describedby={error ? 'join-error' : undefined}
      >
        <Link className="wordmark" href="/">
          WATCH <i>WITH</i> ME
        </Link>
        <p className="kicker">انضمام / 01</p>
        <h1>المقاعد جاهزة.</h1>
        <p>أدخل الرمز الذي وصلك، وسنوصلك إلى الشاشة.</p>
        <label className="label" htmlFor="room">
          رمز الغرفة
        </label>
        <input
          id="room"
          className="input"
          value={roomId}
          onChange={(e) => {
            setRoomId(e.target.value);
            setError('');
          }}
          placeholder="مثلاً: moon-7k2"
          autoCapitalize="none"
          autoComplete="off"
          required
        />
        <label className="label" htmlFor="name">
          اسمك
        </label>
        <input
          id="name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="مثلاً: سامر"
          maxLength={80}
          autoComplete="name"
          required
        />
        {error && (
          <p id="join-error" className="error" role="alert" aria-live="polite">
            {error}
          </p>
        )}
        <button className="button button-primary" disabled={busy} type="submit">
          {busy ? 'جاري الدخول…' : 'ادخل الغرفة  ↗'}
        </button>
      </form>
    </main>
  );
}
