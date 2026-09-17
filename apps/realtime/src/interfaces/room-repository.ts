/** Persistence boundary: implementations may be Prisma, Redis, or an in-memory test double. */
export interface RoomRepositoryPort<Room = unknown> {
  create(room: Room): Promise<void>;
  get(code: string): Promise<Room | undefined>;
  save(room: Room, expectedSequence?: number): Promise<boolean>;
}
