import { CreateRoomResponse } from '@watch-with-me/contracts';

export function saveRoomCredential(response: unknown, storage: Pick<Storage, 'setItem'>) {
  const room = CreateRoomResponse.parse(response);
  storage.setItem(`watch-with-me:${room.roomId}`, JSON.stringify({ token: room.token }));
  return `/room/${encodeURIComponent(room.roomId)}`;
}
