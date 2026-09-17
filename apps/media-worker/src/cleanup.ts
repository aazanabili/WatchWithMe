export type ExpiringAsset = {
  id: string;
  objectKey: string;
  expiresAt: Date;
  subtitles: { objectKey: string }[];
};
export function isExpired(asset: ExpiringAsset, now = new Date()): boolean {
  return asset.expiresAt.getTime() <= now.getTime();
}
export async function cleanupExpired(
  now: () => Date,
  repository: {
    findExpired(): Promise<ExpiringAsset[]>;
    deleteAssets(ids: string[]): Promise<void>;
  },
  objects: { remove(keys: string[]): Promise<void> },
): Promise<number> {
  const assets = (await repository.findExpired()).filter((asset) => isExpired(asset, now()));
  if (!assets.length) return 0;
  const keys = assets.flatMap((asset) => [
    asset.objectKey,
    ...asset.subtitles.map((subtitle) => subtitle.objectKey),
  ]);
  await objects.remove(keys);
  await repository.deleteAssets(assets.map((asset) => asset.id));
  return assets.length;
}
