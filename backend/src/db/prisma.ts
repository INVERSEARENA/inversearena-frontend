import { PrismaClient } from '@prisma/client';
import { getDatabaseConfig, buildDatasourceUrl, validatePgBouncerMode } from '../config/database';

// Get role-specific database configuration
const dbConfig = getDatabaseConfig();
const datasourceUrl = buildDatasourceUrl(dbConfig);

// Validate PgBouncer compatibility
validatePgBouncerMode(datasourceUrl);

// Log configuration
console.log(`[Prisma] Initializing client for role: ${dbConfig.role}`);
console.log(`[Prisma] Connection limit: ${dbConfig.connectionLimit}`);
console.log(`[Prisma] Pool timeout: ${dbConfig.poolTimeout}s`);

// Initialize Prisma client with role-specific pool configuration
export const prisma = new PrismaClient({
  datasourceUrl,
  log: process.env.NODE_ENV === 'development' 
    ? ['query', 'info', 'warn', 'error']
    : ['warn', 'error'],
});

// Connection pool metrics
let isConnected = false;

// Track connection events
prisma.$on('query' as never, () => {
  if (!isConnected) {
    isConnected = true;
    console.log('[Prisma] First query executed, connection pool active');
  }
});

// Graceful shutdown
const cleanup = async () => {
  console.log('[Prisma] Disconnecting...');
  await prisma.$disconnect();
  console.log('[Prisma] Disconnected');
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('beforeExit', cleanup);
