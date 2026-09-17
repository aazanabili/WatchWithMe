import { z } from 'zod';
export const SubtitleFormat = z.enum(['vtt', 'srt']);
export type SubtitleFormat = z.infer<typeof SubtitleFormat>;
export const UploadIntent = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(128),
    sizeBytes: z.number().int().positive().max(10_000_000_000),
    provider: z.literal('upload').default('upload'),
    assetId: z.string().min(1).optional(),
    language: z.string().regex(/^[A-Za-z]{2,12}$/).optional(),
  })
  .strict();
export type UploadIntent = z.infer<typeof UploadIntent>;
export const UploadComplete = z
  .object({ uploadId: z.string().min(1), checksum: z.string().min(1).max(128) })
  .strict();
export type UploadComplete = z.infer<typeof UploadComplete>;
export const UploadStatus = z.enum(['pending', 'completed', 'failed', 'expired']);
export const MediaAsset = z
  .object({
    id: z.string().min(1),
    objectKey: z.string().min(1),
    contentType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    durationSeconds: z.number().nonnegative().nullable(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type MediaAsset = z.infer<typeof MediaAsset>;
export const SubtitleMetadata = z
  .object({
    id: z.string().min(1),
    language: z.string().min(2).max(16),
    format: SubtitleFormat,
    objectKey: z.string().min(1),
  })
  .strict();
export type SubtitleMetadata = z.infer<typeof SubtitleMetadata>;
