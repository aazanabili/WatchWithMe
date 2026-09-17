'use client';
import { useState } from 'react';
export function UploadPanel({
  api,
  roomId,
  token,
  onLoaded,
}: {
  api: string;
  roomId: string;
  token: string;
  onLoaded: (url: string, assetId: string, duration: number | null) => void;
}) {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const upload = async (file: File) => {
    const allowed = ['video/mp4', 'video/webm', 'video/mp2t'];
    if (!allowed.includes(file.type) || file.size > 2 * 1024 ** 3)
      return setStatus('الملف يجب أن يكون MP4 أو WebM أو TS وحجمه حتى 2GB.');
    setProgress(0);
    try {
      setStatus('جاري تجهيز الرفع…');
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const intentResponse = await fetch(
        `${api}/rooms/${encodeURIComponent(roomId)}/media/upload-intent`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: file.name,
            contentType: file.type,
            sizeBytes: file.size,
          }),
        },
      );
      if (!intentResponse.ok) throw new Error('intent');
      const intent = (await intentResponse.json()) as {
        url: string;
        uploadId: string;
        assetId: string;
      };
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', intent.url);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.upload.onprogress = (e) =>
          e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject());
        xhr.onerror = () => reject();
        xhr.send(file);
      });
      const complete = await fetch(
        `${api}/rooms/${encodeURIComponent(roomId)}/media/upload-complete`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ uploadId: intent.uploadId, checksum: 'client-upload' }),
        },
      );
      if (!complete.ok) throw new Error('complete');
      setStatus('تجهيز الفيديو…');
      for (let i = 0; i < 30; i++) {
        const state = (await fetch(
          `${api}/rooms/${encodeURIComponent(roomId)}/media/${intent.assetId}/status`,
          { headers: { Authorization: `Bearer ${token}` } },
        ).then((r) => r.json())) as { status: string; durationSeconds?: number | null };
        if (state.status === 'completed') {
          const playback = (await fetch(
            `${api}/rooms/${encodeURIComponent(roomId)}/media/${intent.assetId}/playback-url`,
            { headers: { Authorization: `Bearer ${token}` } },
          ).then((r) => r.json())) as { url: string };
          onLoaded(playback.url, intent.assetId, state.durationSeconds ?? null);
          setStatus('تم تحميل الفيديو');
          return;
        }
        if (state.status === 'failed' || state.status === 'expired') throw new Error(state.status);
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('timeout');
    } catch {
      setStatus('تعذر رفع الفيديو أو معالجته. حاول مجدداً.');
      setProgress(0);
    }
  };
  return (
    <div className="upload-panel" aria-busy={status.startsWith('جاري') || status.includes('تجهيز')}>
      <label className="label" htmlFor="media-upload">
        رفع فيديو (تنتهي صلاحية الرابط بعد 3 ساعات)
      </label>
      <input
        id="media-upload"
        type="file"
        accept="video/mp4,video/webm,video/mp2t"
        aria-describedby="upload-status"
        onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
      />
      {progress > 0 && (
        <progress max="100" value={progress} aria-label={`تقدم الرفع ${progress}%`} />
      )}
      {status && (
        <p
          id="upload-status"
          role={status.includes('تعذر') ? 'alert' : 'status'}
          aria-live="polite"
        >
          {status}
        </p>
      )}
    </div>
  );
}
