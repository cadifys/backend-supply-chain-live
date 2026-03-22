import app from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { testCentralConnection } from './db/central';

async function start() {
  try {
    // Test DB connection
    await testCentralConnection();

    const server = app.listen(env.port, () => {
      logger.info(`🚀 Server running on port ${env.port} [${env.nodeEnv}]`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down gracefully...');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

start();
