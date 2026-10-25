import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import { errorHandler } from './middlewares/errorHandler';
import authRoutes from './modules/auth/auth.routes';
import descriptionRoutes from './modules/descriptions/descriptions.routes';
import imageRoutes from './modules/images/images.routes';

const app = express();

app.use(cors());
app.use(express.json());

// Docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/descriptions', descriptionRoutes);
app.use('/api/images', imageRoutes);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Error handler (must be last)
app.use(errorHandler);

export default app;
