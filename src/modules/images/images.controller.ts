import { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../utils/response';
import { listImagesQuerySchema } from './images.validators';
import * as imageService from './images.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

function uploadedFiles(req: Request): Express.Multer.File[] {
  if (!req.files) return [];
  if (Array.isArray(req.files)) return req.files;
  return Object.values(req.files).flat();
}

export const uploadHandler = wrap(async (req, res) => {
  const files = uploadedFiles(req);
  if (files.length === 0) {
    throw new Error('Image file is required');
  }

  const images = await imageService.uploadImages(req.userId!, files);
  sendSuccess(res, images, 201);
});

export const listHandler = wrap(async (req, res) => {
  const { page, limit } = listImagesQuerySchema.parse(req.query);
  const result = await imageService.listImages(req.userId!, page, limit);
  sendSuccess(res, result);
});
