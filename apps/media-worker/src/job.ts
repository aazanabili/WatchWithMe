import { z } from 'zod';
const safeKey = (value: string) =>
  !/^[/\\]|\.\./.test(value) && ![...value].some((c) => c.charCodeAt(0) < 32);

export const MediaJob = z
  .object({
    kind: z.enum(['media', 'subtitle']).default('media'),
    assetId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    objectKey: z.string().min(1).max(512).refine(safeKey, 'unsafe object key'),
    contentType: z.enum([
      'video/mp4',
      'video/webm',
      'video/mp2t',
      'text/vtt',
      'application/x-subrip',
    ]),
    sizeBytes: z.number().int().positive().max(2_000_000_000).optional(),
    roomId: z.string().max(128).optional(),
    subtitle: z
      .object({
        id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_-]+$/),
        language: z.string().regex(/^[A-Za-z]{2,12}$/),
        objectKey: z.string().min(1).max(512).refine(safeKey, 'unsafe object key'),
      })
      .optional(),
  })
  .strict();
export type MediaJob = z.infer<typeof MediaJob>;
export function parseJob(value: string): MediaJob {
  return MediaJob.parse(JSON.parse(value));
}
