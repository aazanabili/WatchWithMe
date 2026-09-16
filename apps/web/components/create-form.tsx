'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { saveRoomCredential } from './room-credential';
const API = process.env.NEXT_PUBLIC_API_URL || '/api';
export default function CreateForm() {
  const router = useRouter();
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
        body: JSON.stringify({ displayName: name.trim() }),
      });
      if (!r.ok) throw Error();
      const d = await r.json();
      router.push(saveRoomCredential(d, sessionStorage));
    } catch {
      setError('تعذر إنشاء الغرفة الآن. حاول مجدداً.');
      setBusy(false);
    }
  }
  return (
    <main className="form-page">
      <form
        className="form-card"
        onSubmit={submit}
        aria-describedby={error ? 'create-error' : undefined}
      >
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
          onChange={(e) => {
            setName(e.target.value);
            setError('');
          }}
          placeholder="مثلاً: ليان"
          maxLength={80}
          autoComplete="name"
          required
        />
        {error && (
          <p id="create-error" className="error" role="alert" aria-live="polite">
            {error}
          </p>
        )}
        <button className="button button-primary" disabled={busy} type="submit">
          {busy ? 'جاري الإنشاء…' : 'أنشئ الغرفة  ↗'}
        </button>
      </form>
    </main>
  );
}
