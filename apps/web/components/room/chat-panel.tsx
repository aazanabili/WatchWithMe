'use client';
import { useEffect, useState } from 'react';
type Message = { messageId: string; participantId: string; text: string };
type ChatSocket = {
  emit: (event: string, data?: unknown, ack?: (v: unknown) => void) => void;
  on?: (event: string, listener: (value: unknown) => void) => void;
  off?: (event: string, listener: (value: unknown) => void) => void;
};
export function ChatPanel({
  socket,
  isHost,
  participantId,
}: {
  socket: ChatSocket | null;
  isHost: boolean;
  participantId?: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    if (!socket) return;
    socket.emit('chat.history', {}, (value: unknown) => {
      if (Array.isArray(value)) setMessages(value as Message[]);
    });
    const onMessage = (value: unknown) => {
      const m = value as Message;
      if (m?.messageId && m.text) setMessages((x) => [...x, m]);
    };
    const onDelete = (value: unknown) => {
      const m = value as { messageId?: string };
      if (m.messageId) setMessages((x) => x.filter((y) => y.messageId !== m.messageId));
    };
    socket.on?.('chat.message', onMessage);
    socket.on?.('chat.deleted', onDelete);
    return () => {
      socket.off?.('chat.message', onMessage);
      socket.off?.('chat.deleted', onDelete);
    };
  }, [socket]);
  const send = () => {
    const value = text.trim();
    if (!value || !socket) return;
    socket.emit('chat.send', { text: value });
    setText('');
  };
  return (
    <section className="chat-panel" aria-label="المحادثة">
      <h2>المحادثة</h2>
      <div role="log" aria-live="polite" aria-atomic="false" aria-relevant="additions text">
        {messages.map((m, i) => (
          <p key={m.messageId}>
            <span>{m.participantId === participantId ? 'أنت' : `مشارك ${i + 1}`}</span> {m.text}{' '}
            {isHost && (
              <button
                type="button"
                aria-label={`حذف الرسالة ${i + 1}`}
                onClick={() => {
                  if (window.confirm('هل تريد حذف هذه الرسالة؟'))
                    socket?.emit('chat.delete', { messageId: m.messageId });
                }}
              >
                ×
              </button>
            )}
          </p>
        ))}
      </div>
      <label className="sr-only" htmlFor="chat-message">
        رسالة جديدة
      </label>
      <textarea
        id="chat-message"
        value={text}
        maxLength={2000}
        placeholder="اكتب رسالة… اضغط Enter للإرسال و Shift+Enter لسطر جديد"
        aria-describedby="chat-help"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <span id="chat-help" className="sr-only">
        اضغط Enter للإرسال، أو Shift+Enter لسطر جديد.
      </span>
      <button type="button" onClick={send} disabled={!text.trim()}>
        إرسال
      </button>
    </section>
  );
}
