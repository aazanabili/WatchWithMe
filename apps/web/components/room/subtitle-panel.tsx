'use client';
import { useState } from 'react';
export type ParsedCue = { startTime: number; endTime: number; text: string };
const VTT_TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/;
export function parseVttTimestamp(value: string) {
  const match = VTT_TIME.exec(value.trim());
  if (!match) throw new Error('subtitle_timestamp');
  const hours = Number(match[1] || 0); const minutes = Number(match[2]); const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) throw new Error('subtitle_timestamp');
  return hours * 3600 + minutes * 60 + seconds + Number(match[4]) / 1000;
}
export function parseWebVtt(text: string, maxCues = 1000): ParsedCue[] {
  if (text.length > 20_000_000 || !/^WEBVTT(?:\r?\n|$)/.test(text)) throw new Error('subtitle_invalid');
  if (/<\s*\/?[a-z][^>]*>/i.test(text)) throw new Error('subtitle_invalid');
  const cues: ParsedCue[] = [];
  for (const block of text.replace(/^WEBVTT[^\r\n]*(?:\r?\n){1,2}/, '').split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/); const index = lines.findIndex(line => /-->/.test(line)); if (index < 0) continue;
    const [start, end] = lines[index].split(/\s+-->\s+/); const startTime = parseVttTimestamp(start); const endTime = parseVttTimestamp(end.split(/\s+/)[0]);
    const cueText = lines.slice(index + 1).join('\n').trim();
    if (!cueText || endTime <= startTime || /<\s*\/?[a-z][^>]*>/i.test(cueText)) throw new Error('subtitle_invalid');
    cues.push({ startTime, endTime, text: cueText }); if (cues.length > maxCues) throw new Error('subtitle_limit');
  }
  return cues;
}
export async function fetchValidatedVtt(signedUrl: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(signedUrl); if (!response.ok) throw new Error('subtitle_fetch');
  const text = await response.text(); parseWebVtt(text);
  return text;
}
export async function safeVttSource(signedUrl: string, fetcher: typeof fetch = fetch) {
  const text = await fetchValidatedVtt(signedUrl, fetcher);
  return URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
}
export function SubtitlePanel({
  api,
  roomId,
  token,
  assetId,
  onLoaded,
}: {
  api: string;
  roomId: string;
  token: string;
  assetId?: string;
  onLoaded: (src: string, language: string, text: string | null) => void;
}) {
  const [language, setLanguage] = useState('ar');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    const format = file.name.toLowerCase().endsWith('.srt')
      ? 'srt'
      : file.name.toLowerCase().endsWith('.vtt')
        ? 'vtt'
        : '';
    if (!format || !assetId)
      return setMessage(!assetId ? 'حمّل الفيديو أولاً.' : 'اختر ملف VTT أو SRT.');
    setBusy(true);
    setMessage('جاري رفع الترجمة…');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    try {
      const intentResponse = await fetch(
        `${api}/rooms/${encodeURIComponent(roomId)}/media/subtitle-intent`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: file.name,
            contentType: format === 'vtt' ? 'text/vtt' : 'application/x-subrip',
            sizeBytes: file.size,
            assetId,
            language,
          }),
        },
      );
      if (!intentResponse.ok) throw new Error();
      const intent = (await intentResponse.json()) as { url: string; uploadId: string };
      const put = await fetch(intent.url, {
        method: 'PUT',
        headers: { 'Content-Type': format === 'vtt' ? 'text/vtt' : 'application/x-subrip' },
        body: file,
      });
      if (!put.ok) throw new Error();
      const done = await fetch(
        `${api}/rooms/${encodeURIComponent(roomId)}/media/subtitle-complete`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ uploadId: intent.uploadId, checksum: 'client-subtitle' }),
        },
      );
      if (!done.ok) throw new Error();
      for (let i = 0; i < 30; i++) {
        const state = (await fetch(
          `${api}/rooms/${encodeURIComponent(roomId)}/media/${assetId}/subtitles`,
          { headers: { Authorization: `Bearer ${token}` } },
        ).then((r) => r.json())) as { tracks?: Array<{ url?: string; language?: string }> };
        const track = state.tracks?.find((candidate) => candidate.language === language && candidate.url);
        if (track?.url) {
            let source = track.url; let validatedText: string | null = null;
            try { validatedText = await fetchValidatedVtt(track.url); source = URL.createObjectURL(new Blob([validatedText], { type: 'text/vtt' })); } catch (reason) {
              if (reason instanceof Error && reason.message === 'subtitle_invalid') throw reason;
              setMessage('تعذر جلب الترجمة محلياً؛ جارٍ استخدام الرابط الموقّع.');
            }
            onLoaded(source, language, validatedText);
            setMessage('تمت إضافة الترجمة.');
            return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error();
    } catch {
      setMessage('تعذر رفع أو معالجة الترجمة.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="subtitle-panel" aria-busy={busy}>
      <label className="label" htmlFor="subtitle-language">
        لغة الترجمة
      </label>
      <input
        id="subtitle-language"
        value={language}
        maxLength={16}
        onChange={(e) => setLanguage(e.target.value)}
        disabled={busy}
      />
      <label className="label" htmlFor="subtitle-file">
        ترجمة VTT/SRT
      </label>
      <input
        id="subtitle-file"
        type="file"
        accept=".vtt,.srt,text/vtt,application/x-subrip"
        disabled={busy}
        onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
      />
      {message && (
        <p role={message.includes('تعذر') ? 'alert' : 'status'} aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}
