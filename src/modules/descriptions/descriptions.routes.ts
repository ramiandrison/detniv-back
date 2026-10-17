import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth';
import { listHandler, createHandler, removeHandler } from './descriptions.controller';

const router = Router();

router.use(requireAuth);

/**
 * @swagger
 * tags:
 *   name: Descriptions
 *   description: Saved description templates (CRUD)
 */

/**
 * @swagger
 * /descriptions:
 *   get:
 *     summary: List the authenticated user's description templates
 *     tags: [Descriptions]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of templates
 *       401:
 *         description: Not authenticated
 */
router.get('/', listHandler);

/**
 * @swagger
 * /descriptions:
 *   post:
 *     summary: Create a description template
 *     tags: [Descriptions]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, text]
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 120
 *               text:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 2000
 *     responses:
 *       201:
 *         description: Template created
 *       400:
 *         description: Validation error or too many descriptions
 */
router.post('/', createHandler);

/**
 * @swagger
 * /descriptions/{id}:
 *   delete:
 *     summary: Delete a description template
 *     tags: [Descriptions]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
router.delete('/:id', removeHandler);

export default router;
