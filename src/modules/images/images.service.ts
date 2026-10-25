import { prisma } from '../../config/prisma';
import { uploadImage } from './b2.service';

export interface PhotoRef {
  photoId: string;
  fullSizeUrl: string;
}

export interface ImageMeta {
  vintedUserId: string;
  articleId: string;
  photos: PhotoRef[];
}

export const MAX_PHOTOS_PER_REQUEST = 20;
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 60_000;

const imageSelect = {
  id: true,
  url: true,
  fileName: true,
  originalName: true,
  contentType: true,
  size: true,
  createdAt: true,
} as const;

/** Chemin B2 : `repost_photos/vintedUserId/articleId/photosId` */
function objectKey(
  vintedUserId: string,
  articleId: string,
  photoId: string
): string {
  return `repost_photos/${vintedUserId}/${articleId}/${photoId}`;
}

function extensionFromContentType(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const clean = (contentType || '').split(';')[0].trim().toLowerCase();
  return map[clean] || 'jpg';
}

function sanitizeSegment(value: string): string {
  return encodeURIComponent(value).replace('%2F', '_');
}

/** Télécharge le `full_size_url` (et non le thumbnail) d'une photo Vinted. */
async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    throw new Error('Image too large');
  }
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  return buffer;
}

export async function uploadImages(userId: number, meta: ImageMeta) {
  const { vintedUserId, articleId, photos } = meta;

  if (photos.length === 0) {
    throw new Error('photos are required');
  }
  if (photos.length > MAX_PHOTOS_PER_REQUEST) {
    throw new Error(`Too many photos (max ${MAX_PHOTOS_PER_REQUEST})`);
  }

  const results = [];
  for (const photo of photos) {
    const buffer = await downloadImage(photo.fullSizeUrl);
    const contentType = responseContentType(photo.fullSizeUrl);
    const extension = extensionFromContentType(contentType);
    const fileName = `${objectKey(vintedUserId, articleId, photo.photoId)}.${extension}`;

    const stored = await uploadImage(buffer, fileName, contentType);
    results.push({
      userId,
      vintedUserId,
      articleId,
      bucketFileId: stored.fileId,
      fileName,
      originalName: `${sanitizeSegment(photo.photoId)}.${extension}`.slice(0, 255),
      contentType,
      size: buffer.length,
      url: stored.url,
    });
  }

  return prisma.$transaction(
    results.map((data) =>
      prisma.repostImage.create({
        data,
        select: imageSelect,
      })
    )
  );
}

function responseContentType(fullSizeUrl: string): string {
  // Default heuristic from URL extension when content-type isn't available
  const ext = fullSizeUrl.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

export async function listImages(userId: number, page: number, limit: number) {
  const where = { userId };
  const [total, items] = await prisma.$transaction([
    prisma.repostImage.count({ where }),
    prisma.repostImage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: imageSelect,
    }),
  ]);

  return { items, total, page, limit };
}
