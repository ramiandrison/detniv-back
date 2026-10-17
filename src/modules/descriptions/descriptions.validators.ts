import { z } from 'zod';

export const createDescriptionSchema = z.object({
  name: z.string().trim().min(2).max(120),
  text: z.string().trim().min(1).max(2000),
});

export const descriptionIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});
