// An in-process Redis with the ioredis API (ioredis-mock). It needs no server on the VM.
// In production you would swap this one line for `new Redis(process.env.REDIS_URL)` from the `ioredis` package
// (Azure Cache for Redis is the managed equivalent). Code that uses get/set/del/ttl/incr moves across unchanged.
import Redis from 'ioredis-mock';

export function createRedis() {
  return new Redis();
}
