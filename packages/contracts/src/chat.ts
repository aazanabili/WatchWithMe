import { z } from 'zod';
export const ChatEvent = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('message'),
      messageId: z.string(),
      participantId: z.string(),
      text: z.string().trim().min(1).max(2000),
      expiresAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      type: z.literal('moderated'),
      messageId: z.string(),
      action: z.enum(['hidden', 'removed']),
      reason: z.string().max(256).optional(),
    })
    .strict(),
]);
export type ChatEvent = z.infer<typeof ChatEvent>;
export const ChatModerationCommand = z
  .object({
    messageId: z.string().min(1),
    action: z.enum(['hide', 'remove']),
    reason: z.string().max(256).optional(),
  })
  .strict();
export type ChatModerationCommand = z.infer<typeof ChatModerationCommand>;
