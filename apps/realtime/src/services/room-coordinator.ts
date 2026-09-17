/** Serializes room work without coupling routers to the selected persistence adapter. */
export class RoomCoordinator {
  private readonly queues = new Map<string, Promise<void>>();
  enqueue(roomId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(roomId) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.queues.set(roomId, next);
    void next.finally(() => {
      if (this.queues.get(roomId) === next) this.queues.delete(roomId);
    });
    return next;
  }
}
