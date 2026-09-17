import { z } from 'zod';
export const ConferencePolicy = z
  .object({
    enabled: z.boolean(),
    maxParticipants: z.number().int().positive().max(100).nullable(),
    requireHostApproval: z.boolean(),
  })
  .strict();
export type ConferencePolicy = z.infer<typeof ConferencePolicy>;
export const ConferencePermissions = z
  .object({ canPublishAudio: z.boolean(), canPublishVideo: z.boolean(), canPublishScreen: z.boolean(), canSubscribe: z.boolean() })
  .strict();
export type ConferencePermissions = z.infer<typeof ConferencePermissions>;
export const ConferenceTokenDto = z
  .object({
    version: z.literal('v1'),
    token: z.string().min(1),
    roomName: z.string().min(1),
    participantId: z.string().min(1),
    permissions: ConferencePermissions,
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ConferenceTokenDto = z.infer<typeof ConferenceTokenDto>;
