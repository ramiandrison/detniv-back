import { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../utils/response';
import { listImagesQuerySchema } from './images.validators';
import { uploadImagesSchema } from './images.validators';
import * as imageService from './images.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export const uploadHandler = wrap(async (req, res) => {
  const body = uploadImagesSchema.parse(req.body);
  const images = await imageService.uploadImages(req.userId!, {
    vintedUserId: body.vinted_user_id,
    articleId: body.article_id,
    photos: body.photos.map((p) => ({
      photoId: p.photo_id,
      fullSizeUrl: p.full_size_url,
    })),
  });
  sendSuccess(res, images, 201);
});

export const listHandler = wrap(async (req, res) => {
  const { page, limit } = listImagesQuerySchema.parse(req.query);
  const result = await imageService.listImages(req.userId!, page, limit);
  sendSuccess(res, result);
});
