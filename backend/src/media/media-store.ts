import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { imageInfo } from './image-info';

/** Largest accepted product image (bytes). Enforced by multer (`limits.fileSize`, answers 413) and re-checked here. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** `uri` handed out for a stored image. Product `main_images[].uri` values that match it point at a MediaAsset row. */
export const MEDIA_URI_PREFIX = 'sim-media/';
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StoredImage {
  id: string;
  uri: string;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
}

export type ImageRejection = 'not_an_image' | 'too_large';

/** Absolute public URL of GET /demo/media/images/{id} (an <img> needs no session). */
export function mediaUrl(publicApiBaseUrl: string, id: string): string {
  return `${publicApiBaseUrl.replace(/\/$/, '')}/demo/media/images/${id}`;
}

/** The MediaAsset id inside a `sim-media/{uuid}` uri, else undefined. */
export function mediaIdFromUri(uri: string): string | undefined {
  if (!uri.startsWith(MEDIA_URI_PREFIX)) return undefined;
  const id = uri.slice(MEDIA_URI_PREFIX.length);
  return MEDIA_ID.test(id) ? id : undefined;
}

export const isMediaId = (id: string): boolean => MEDIA_ID.test(id);

/** Validates the bytes (magic numbers, size) and stores them. Returns the rejection reason instead of throwing. */
export async function storeImage(
  prisma: Pick<PrismaClient, 'mediaAsset'>,
  shopId: string,
  bytes: Buffer,
  publicApiBaseUrl: string,
  now: Date,
): Promise<StoredImage | ImageRejection> {
  if (bytes.length > MAX_IMAGE_BYTES) return 'too_large';
  const info = imageInfo(bytes);
  if (!info) return 'not_an_image';
  const id = randomUUID();
  await prisma.mediaAsset.create({
    data: { id, shopId, mimeType: info.mimeType, bytes, width: info.width, height: info.height, sizeBytes: bytes.length, createdAt: now },
  });
  return { id, uri: `${MEDIA_URI_PREFIX}${id}`, url: mediaUrl(publicApiBaseUrl, id), width: info.width, height: info.height, mimeType: info.mimeType, sizeBytes: bytes.length };
}
