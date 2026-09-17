import { z } from 'zod';
export const HostTransferPolicy = z.enum(['auto_transfer_oldest']);
export type HostTransferPolicy = z.infer<typeof HostTransferPolicy>;
export const LeaveRoomRequest = z.object({ roomId: z.string().min(1) }).strict();
export const LogoutRoomRequest = LeaveRoomRequest;
export const RevokeParticipantRequest = z
  .object({ roomId: z.string().min(1), participantId: z.string().min(1) })
  .strict();
export const TransferHostRequest = z
  .object({ roomId: z.string().min(1), participantId: z.string().min(1) })
  .strict();
export const RoomPolicy = z
  .object({ hostTransfer: HostTransferPolicy.default('auto_transfer_oldest') })
  .strict();
export type RoomPolicy = z.infer<typeof RoomPolicy>;
