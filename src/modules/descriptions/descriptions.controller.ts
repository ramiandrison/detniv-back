import { Request, Response, NextFunction } from 'express';
import * as descriptionService from './descriptions.service';
import { createDescriptionSchema, descriptionIdSchema } from './descriptions.validators';
import { sendSuccess } from '../../utils/response';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export const listHandler = wrap(async (req, res) => {
  const items = await descriptionService.listDescriptions(req.userId!);
  sendSuccess(res, items);
});

export const createHandler = wrap(async (req, res) => {
  const { name, text } = createDescriptionSchema.parse(req.body);
  const item = await descriptionService.createDescription(req.userId!, name, text);
  sendSuccess(res, item, 201);
});

export const removeHandler = wrap(async (req, res) => {
  const { id } = descriptionIdSchema.parse(req.params);
  await descriptionService.deleteDescription(req.userId!, id);
  sendSuccess(res, { message: 'Description deleted.' });
});
