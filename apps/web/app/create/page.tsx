'use client';
import Link from 'next/link';
import { useState } from 'react';
const API = process.env.NEXT_PUBLIC_API_URL || '/api';
export default function CreatePage() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('اكتب اسماً يظهر للآخرين.');
    setBusy(true);
    try {
      const r = await fetch(`${API}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: name }),
      });
      if (!r.ok) throw Error();
      const d = await r.json();
      sessionStorage.setItem(
        `watch-with-me:${d.roomId}`,
        JSON.stringify({ token: d.token, participantId: d.participantId, role: d.role }),
      );
      location.href = `/room/${encodeURIComponent(d.roomId)}`;
    } catch {
      setError('تعذر إنشاء الغرفة الآن. حاول مجدداً.');
      setBusy(false);
    }
  }
  return (
    <main className="form-page">
      <form className="form-card" onSubmit={submit}>
        <Link className="wordmark" href="/">
          WATCH <i>WITH</i> ME
        </Link>
        <p className="kicker">غرفة جديدة / 01</p>
        <h1>أين نشاهد الليلة؟</h1>
        <p>ابدأ غرفة خاصة وشارك الرابط مع من تحب.</p>
        <label className="label" htmlFor="name">
          اسمك في الغرفة
        </label>
        <input
          id="name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="مثلاً: ليان"
          maxLength={80}
          autoComplete="name"
        />
        {error && (
          <p className="error" aria-live="polite">
            {error}
          </p>
        )}
        <button className="button button-primary" disabled={busy}>
          {busy ? 'جاري الإنشاء…' : 'أنشئ الغرفة  ↗'}
        </button>
      </form>
    </main>
  );
}
