import { z } from 'zod';

export const MediaProvider = z.enum([
  'youtube',
  'upload',
  'mp4',
  'instagram',
  'tiktok',
  'vimeo',
  'dailymotion',
  'twitch',
  'facebook',
]);
export type MediaProvider = z.infer<typeof MediaProvider>;
export const SyncMode = z.enum(['full', 'view_only']);
export type SyncMode = z.infer<typeof SyncMode>;
export const MediaCapabilities = z
  .object({ canPlay: z.boolean(), canSeek: z.boolean(), canSync: z.boolean() })
  .strict();
export type MediaCapabilities = z.infer<typeof MediaCapabilities>;
export const MediaDescriptor = z
  .object({
    provider: MediaProvider,
    mediaId: z.string().trim().min(1).max(2048),
    title: z.string().max(512).optional(),
    durationSeconds: z.number().finite().nonnegative().nullable(),
    syncMode: SyncMode,
    capabilities: MediaCapabilities,
  })
  .strict();
export type MediaDescriptor = z.infer<typeof MediaDescriptor>;
export const MediaProviderCapabilities = z
  .object({ provider: MediaProvider, capabilities: MediaCapabilities })
  .strict();
export type MediaProviderCapabilities = z.infer<typeof MediaProviderCapabilities>;
