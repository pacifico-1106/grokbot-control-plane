/**
 * Rate limiting for LP forms.
 * Feature flag LP_INQUIRY_BOT_PROTECTION_ENABLED must be ON.
 * 
 * Uses in-memory store for now. Production should use Redis or similar.
 * IP addresses are hashed with IP_HASH_KEY to avoid storing raw IPs.
 */

import { createHash } from "node:crypto";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds?: number;
}

const DEFAULT_IP_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 5,
};

const DEFAULT_GLOBAL_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 100,
};

const ipBuckets = new Map<string, { count: number; resetAt: number }>();
const globalBucket = { count: 0, resetAt: 0 };

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of ipBuckets.entries()) {
      if (bucket.resetAt < now) {
        ipBuckets.delete(key);
      }
    }
    if (globalBucket.resetAt < now) {
      globalBucket.count = 0;
      globalBucket.resetAt = 0;
    }
  }, 60 * 1000);
}

export function hashIp(ip: string): string {
  const key = process.env.IP_HASH_KEY || "default_hash_key_for_dev";
  return createHash("sha256").update(`${key}:${ip}`).digest("hex").slice(0, 16);
}

export function checkIpRateLimit(
  ipHash: string,
  config: RateLimitConfig = DEFAULT_IP_LIMIT
): RateLimitResult {
  startCleanup();
  
  const now = Date.now();
  let bucket = ipBuckets.get(ipHash);
  
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + config.windowMs };
    ipBuckets.set(ipHash, bucket);
  }
  
  bucket.count++;
  
  if (bucket.count > config.maxRequests) {
    const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetAt: bucket.resetAt,
      retryAfterSeconds,
    };
  }
  
  return {
    allowed: true,
    remaining: config.maxRequests - bucket.count,
    resetAt: bucket.resetAt,
  };
}

export function checkGlobalRateLimit(
  config: RateLimitConfig = DEFAULT_GLOBAL_LIMIT
): RateLimitResult {
  startCleanup();
  
  const now = Date.now();
  
  if (globalBucket.resetAt < now) {
    globalBucket.count = 0;
    globalBucket.resetAt = now + config.windowMs;
  }
  
  globalBucket.count++;
  
  if (globalBucket.count > config.maxRequests) {
    const retryAfterSeconds = Math.ceil((globalBucket.resetAt - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetAt: globalBucket.resetAt,
      retryAfterSeconds,
    };
  }
  
  return {
    allowed: true,
    remaining: config.maxRequests - globalBucket.count,
    resetAt: globalBucket.resetAt,
  };
}

export function checkRateLimits(
  ipHash: string,
  ipConfig?: RateLimitConfig,
  globalConfig?: RateLimitConfig
): RateLimitResult {
  const globalResult = checkGlobalRateLimit(globalConfig);
  if (!globalResult.allowed) {
    return globalResult;
  }
  
  return checkIpRateLimit(ipHash, ipConfig);
}

export function resetRateLimits(): void {
  ipBuckets.clear();
  globalBucket.count = 0;
  globalBucket.resetAt = 0;
}
