import Redis from 'ioredis';
import { Client } from 'minio';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { parseJob } from './job.js';
import {
  convertMedia,
  ffprobeDuration,
  srtToVtt,
  validateSubtitle,
  writeStream,
  tempPath,
} from './process.js';
import { cleanupExpired } from './cleanup.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const minio = new Client({
  endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
});
const bucket = process.env.MINIO_BUCKET ?? 'media';
const maxBytes = Math.min(Number(process.env.MEDIA_MAX_BYTES ?? 2_000_000_000), 2_000_000_000);
const timeout = Number(process.env.MEDIA_JOB_TIMEOUT_MS ?? 15 * 60_000);
async function updateAsset(id: string, data: Record<string, unknown>) {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    await db.mediaAsset.update({ where: { id }, data: data as never });
  } finally {
    await db.$disconnect();
  }
}
async function completeAsset(
  id: string,
  durationSeconds: number,
  outputKey: string,
  subtitle?: { id: string; language: string; objectKey: string },
) {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.mediaAsset.update({
        where: { id },
        data: { durationSeconds, objectKey: outputKey },
      });
      if (subtitle) {
        const subtitleTrack = subtitle;
        await tx.subtitleTrack.create({
          data: {
            id: subtitleTrack.id,
            assetId: id,
            language: subtitleTrack.language,
            format: 'VTT',
            objectKey: subtitleTrack.objectKey,
          },
        });
        await tx.$executeRaw`UPDATE "SubtitleTrack" SET "status" = 'READY' WHERE "id" = ${subtitleTrack.id}`;
      }
    });
  } finally {
    await db.$disconnect();
  }
}
async function completeSubtitle(id: string, assetId: string, roomId: string, objectKey: string) {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const track = await db.subtitleTrack.findUnique({ where: { id }, include: { asset: true } });
    const status = await db.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "SubtitleTrack" WHERE "id" = ${id}`;
    if (!track || track.assetId !== assetId || track.asset.roomId !== roomId || track.asset.durationSeconds == null || status[0]?.status !== 'PENDING')
      throw new Error('invalid subtitle ownership or asset state');
    await db.subtitleTrack.update({ where: { id }, data: { objectKey } });
    await db.$executeRaw`UPDATE "SubtitleTrack" SET "status" = 'READY' WHERE "id" = ${id}`;
  }
  finally { await db.$disconnect(); }
}
async function run(raw: string) {
  const job = parseJob(raw);
  if (job.roomId && !job.objectKey.startsWith(`${job.roomId}/`))
    throw new Error('invalid object ownership');
  const dir = await mkdtemp(path.join(tmpdir(), 'media-'));
  const input = tempPath(dir, job.objectKey);
  try {
    const stream = await minio.getObject(bucket, job.objectKey);
    const downloadedBytes = await writeStream(stream, input, maxBytes);
    if (job.sizeBytes !== undefined && downloadedBytes !== job.sizeBytes)
      throw new Error('uploaded size mismatch');
    if (job.kind === 'subtitle') {
      if (!job.subtitle) throw new Error('subtitle metadata required');
      const text = await (await import('node:fs/promises')).readFile(input, 'utf8');
      const format = job.contentType === 'text/vtt' ? 'vtt' : 'srt';
      if (!validateSubtitle(text, format)) throw new Error('invalid subtitle');
      const vtt = format === 'vtt' ? text : srtToVtt(text);
      const vttFile = path.join(dir, `${job.subtitle.id}.vtt`);
      await (await import('node:fs/promises')).writeFile(vttFile, vtt);
      const outputKey = `processed/subtitles/${job.assetId}/${job.subtitle.language}.vtt`;
      await minio.fPutObject(bucket, outputKey, vttFile, { 'Content-Type': 'text/vtt' });
       await completeSubtitle(job.subtitle.id, job.assetId, job.roomId ?? '', outputKey);
      return;
    }
    const duration = await ffprobeDuration(input);
    const ext = path.extname(job.objectKey).toLowerCase();
    const output = path.join(dir, `${job.assetId}.mp4`);
    await convertMedia(input, output, ext);
    const outputKey = `processed/${job.assetId}.mp4`;
    await minio.fPutObject(bucket, outputKey, output, { 'Content-Type': 'video/mp4' });
    let subtitleRecord: { id: string; language: string; objectKey: string } | undefined;
    if (job.subtitle) {
      const sub = await minio.getObject(bucket, job.subtitle.objectKey);
      const subInput = tempPath(dir, job.subtitle.objectKey);
      await writeStream(sub, subInput, 20 * 1024 * 1024);
      const text = await (await import('node:fs/promises')).readFile(subInput, 'utf8');
      const format = /^WEBVTT(?:\r?\n|$)/.test(text) ? 'vtt' : 'srt';
      if (!validateSubtitle(text, format)) throw new Error('invalid subtitle');
      const vtt = format === 'vtt' ? text : srtToVtt(text);
      const vttFile = path.join(dir, `${job.subtitle.id}.vtt`);
      await (await import('node:fs/promises')).writeFile(vttFile, vtt);
      const key = `processed/subtitles/${job.assetId}/${job.subtitle.language}.vtt`;
      await minio.fPutObject(bucket, key, vttFile, { 'Content-Type': 'text/vtt' });
      subtitleRecord = { id: job.subtitle.id, language: job.subtitle.language, objectKey: key };
    }
    await completeAsset(job.assetId, duration, outputKey, subtitleRecord);
  } catch (error) {
    console.error('media job failed');
    try {
      await updateAsset(job.assetId, { durationSeconds: null });
    } catch {
      console.error('asset failure update failed');
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function main() {
  console.info('media-worker consuming media:jobs');
  const cleanup = async () => {
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient();
    try {
      await cleanupExpired(
        () => new Date(),
        {
          findExpired: () =>
            db.mediaAsset.findMany({
              where: { expiresAt: { lte: new Date() } },
              include: { subtitles: true },
            }),
          deleteAssets: async (ids) => {
            await db.mediaAsset.deleteMany({ where: { id: { in: ids } } });
          },
        },
        {
          remove: async (keys) => {
            if (keys.length) await minio.removeObjects(bucket, keys);
          },
        },
      );
    } finally {
      await db.$disconnect();
    }
  };
  await cleanup().catch((error) => console.error('media cleanup failed', error));
  const cleanupTimer = setInterval(
    () => void cleanup().catch((error) => console.error('media cleanup failed', error)),
    5 * 60_000,
  );
  cleanupTimer.unref();
  while (true) {
    const item = await redis.brpop('media:jobs', 5);
    if (!item) continue;
    await Promise.race([
      run(item[1]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('job timeout')), timeout)),
    ]).catch((error) => console.error(error));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
