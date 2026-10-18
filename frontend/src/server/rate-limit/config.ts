import { getRoutePolicy, type RateLimitPolicyConfig } from "@inversearena/rate-limit";

export type RouteRateLimitConfig = RateLimitPolicyConfig;

export const nonceRateLimitConfig: RouteRateLimitConfig = getRoutePolicy("AUTH_NONCE");
