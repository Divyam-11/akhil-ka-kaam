import { Redis } from 'ioredis';

/**
 * Connection options for BullMQ. Workers and Queue objects require maxRetriesPerRequest=null
 * for blocking commands; the API uses the same shape for simplicity.
 */
export function createRedis(url: string, name: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: name,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  client.on('error', () => undefined);
  return client;
}
