import { z } from 'zod';
import { MAX_PHOTOS_PER_REQUEST } from './images.service';

export const listImagesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const uploadImagesSchema = z.object({
  vinted_user_id: z.string().min(1).max(64),
  article_id: z.string().min(1).max(64),
  photos: z
    .array(
      z.object({
        photo_id: z.string().min(1),
        full_size_url: z.string().url(),
      })
    )
    .min(1)
    .max(MAX_PHOTOS_PER_REQUEST),
});
