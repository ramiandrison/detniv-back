import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth';
import { listHandler, uploadHandler } from './images.controller';

const router = Router();

router.use(requireAuth);

/**
 * @swagger
 * tags:
 *   name: Images
 *   description: Téléchargement et consultation des images stockées sur Backblaze B2
 */

/**
 * @swagger
 * /images:
 *   post:
 *     summary: Upload one or more Vinted photos (full_size_url)
 *     tags: [Images]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vinted_user_id, article_id, photos]
 *             properties:
 *               vinted_user_id:
 *                 type: string
 *               article_id:
 *                 type: string
 *               photos:
 *                 type: array
 *                 maxItems: 20
 *                 items:
 *                   type: object
 *                   required: [photo_id, full_size_url]
 *                   properties:
 *                     photo_id:
 *                       type: string
 *                     full_size_url:
 *                       type: string
 *     responses:
 *       201:
 *         description: Photos downloaded and uploaded
 *       400:
 *         description: Invalid request body
 *       503:
 *         description: Image storage not configured
 *       502:
 *         description: Backblaze storage or image download unavailable
 */
router.post('/', uploadHandler);

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
