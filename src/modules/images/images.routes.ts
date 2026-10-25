import { RequestHandler, Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../middlewares/requireAuth';
import { sendError } from '../../utils/response';
import { listHandler, uploadHandler } from './images.controller';
import {
  MAX_IMAGES_PER_REQUEST,
  MAX_IMAGE_SIZE_BYTES,
} from './images.service';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES,
    files: MAX_IMAGES_PER_REQUEST,
  },
});

const uploadFields = upload.fields([
  { name: 'files', maxCount: MAX_IMAGES_PER_REQUEST },
  { name: 'file', maxCount: 1 },
]);

const handleUpload: RequestHandler = (req, res, next) => {
  uploadFields(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        sendError(
          res,
          `Image too large (max ${MAX_IMAGE_SIZE_BYTES / (1024 * 1024)} MB)`,
          413
        );
        return;
      }
      if (error.code === 'LIMIT_FILE_COUNT') {
        sendError(
          res,
          `Too many images (max ${MAX_IMAGES_PER_REQUEST})`,
          400
        );
        return;
      }
      if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        sendError(res, 'Unexpected file field', 400);
        return;
      }
      sendError(res, 'Invalid image upload', 400);
      return;
    }
    if (error) {
      next(error);
      return;
    }
    next();
  });
};

router.use(requireAuth);

/**
 * @swagger
 * tags:
 *   name: Images
 *   description: Upload et consultation des images stockées sur Backblaze B2
 */

/**
 * @swagger
 * /images:
 *   post:
 *     summary: Upload one or more images
 *     tags: [Images]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 maxItems: 20
 *                 items:
 *                   type: string
 *                   format: binary
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Images uploaded
 *       400:
 *         description: Missing file or invalid upload
 *       413:
 *         description: Image too large
 *       415:
 *         description: Unsupported image type
 *       503:
 *         description: Image storage not configured
 *       502:
 *         description: Backblaze storage unavailable
 */
router.post('/', handleUpload, uploadHandler);

/**
 * @swagger
 * /images:
 *   get:
 *     summary: List the authenticated user's images and public URLs
 *     tags: [Images]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
 *     responses:
 *       200:
 *         description: Paginated image list
 *       401:
 *         description: Not authenticated
 */
router.get('/', listHandler);

export default router;
