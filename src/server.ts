import { env } from './config/env';
import app from './app';

app.listen(env.port, () => {
  console.log(`🚀 Server running on http://localhost:${env.port}`);
  console.log(`📚 Swagger docs at http://localhost:${env.port}/docs`);
});
