export type HealthStatus = 'ok' | 'degraded';

export interface ApiError {
  code: string;
  message: string;
  correlationId: string;
  details?: unknown;
}