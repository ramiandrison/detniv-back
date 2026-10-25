import { randomUUID } from 'crypto';
import { prisma } from '../../config/prisma';
import { uploadImage } from './b2.service';
import { detectImageType } from './image-file';

export const MAX_IMAGES_PER_REQUEST = 20;
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

export interface IncomingImage {
  buffer: Buffer;
  originalname: string;
}

const imageSelect = {
  id: true,
  url: true,
  fileName: true,
  originalName: true,
  contentType: true,
  size: true,
  createdAt: true,
} as const;

function objectKey(userId: number, extension: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `users/${userId}/${year}/${month}/${randomUUID()}.${extension}`;
}

function safeOriginalName(name: string, extension: string): string {
  const base = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() as string;
  return (base || `image.${extension}`).slice(0, 255);
}

export async function uploadImages(userId: number, files: IncomingImage[]) {
  const prepared = files.map((file) => {
    const detected = detectImageType(file.buffer);
    if (!detected) {
      throw new Error('Unsupported image type');
    }
    return {
      file,
      contentType: detected.contentType,
      extension: detected.extension,
      fileName: objectKey(userId, detected.extension),
    };
  });

  const uploaded: Array<{
    userId: number;
    bucketFileId: string;
    fileName: string;
    originalName: string;
    contentType: string;
    size: number;
    url: string;
  }> = [];

  for (const item of prepared) {
    try {
      const stored = await uploadImage(
        item.file.buffer,
        item.fileName,
        item.contentType
      );
      uploaded.push({
        userId,
        bucketFileId: stored.fileId,
        fileName: item.fileName,
        originalName: safeOriginalName(
          item.file.originalname,
          item.extension
        ),
        contentType: item.contentType,
        size: item.file.buffer.length,
        url: stored.url,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Image storage is not configured'
      ) {
        throw error;
      }
      console.error(
        '[images] Backblaze upload failed',
        error instanceof Error ? error.message : error
      );
      throw new Error('Image storage unavailable');
    }
  }

  return prisma.$transaction(
    uploaded.map((data) =>
      prisma.image.create({
        data,
        select: imageSelect,
      })
    )
  );
}

export async function listImages(userId: number, page: number, limit: number) {
  const where = { userId };
  const [total, items] = await prisma.$transaction([
    prisma.image.count({ where }),
    prisma.image.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: imageSelect,
    }),
  ]);

  return { items, total, page, limit };
}
