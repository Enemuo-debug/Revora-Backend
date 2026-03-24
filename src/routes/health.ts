import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { ErrorCode, AppError } from '../lib/errors';

/**
 * @notice Health check response interface for consistent API responses
 * @dev Provides structured health status with detailed component information
 */
export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  service: string;
  version: string;
  timestamp: string;
  uptime: number;
  checks: {
    database: ComponentHealth;
    stellar: ComponentHealth;
    memory?: ComponentHealth;
    disk?: ComponentHealth;
  };
  requestId?: string;
}

/**
 * @notice Individual component health status
 * @dev Standardized health check result for each system component
 */
export interface ComponentHealth {
  status: 'up' | 'down' | 'degraded';
  latencyMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * @notice Readiness probe response interface
 * @dev Simplified response for Kubernetes readiness probes
 */
export interface ReadinessResponse {
  ready: boolean;
  service: string;
  timestamp: string;
  checks: string[];
}

/**
 * @notice Health check configuration options
 * @dev Configurable timeouts and thresholds for health checks
 */
export interface HealthCheckConfig {
  dbTimeoutMs: number;
  stellarTimeoutMs: number;
  memoryThresholdMb: number;
  diskThresholdPercent: number;
}

// Default configuration values
const DEFAULT_CONFIG: HealthCheckConfig = {
  dbTimeoutMs: 5000,
  stellarTimeoutMs: 3000,
  memoryThresholdMb: 512,
  diskThresholdPercent: 90,
};

/**
 * @notice Database health check with timeout and detailed metrics
 * @dev Performs connection test with latency measurement and error handling
 * @param pool PostgreSQL connection pool
 * @param timeoutMs Maximum time to wait for database response
 * @return ComponentHealth with status, latency, and error details
 */
export const checkDatabaseHealth = async (
  pool: Pool,
  timeoutMs: number = DEFAULT_CONFIG.dbTimeoutMs
): Promise<ComponentHealth> => {
  const start = Date.now();
  
  try {
    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Database health check timeout')), timeoutMs);
    });

    // Race between the query and timeout
    await Promise.race([
      pool.query('SELECT 1 as health_check, NOW() as server_time'),
      timeoutPromise
    ]);

    const latencyMs = Date.now() - start;
    
    return {
      status: latencyMs > 1000 ? 'degraded' : 'up',
      latencyMs,
      details: {
        connectionCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      }
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    return {
      status: 'down',
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * @notice Stellar Horizon health check with timeout and network validation
 * @dev Verifies Stellar network connectivity and response time
 * @param timeoutMs Maximum time to wait for Stellar response
 * @return ComponentHealth with status, latency, and error details
 */
export const checkStellarHealth = async (
  timeoutMs: number = DEFAULT_CONFIG.stellarTimeoutMs
): Promise<ComponentHealth> => {
  const start = Date.now();
  const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org';
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${horizonUrl}/`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'revora-backend-health-check/1.0',
      },
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        status: 'down',
        latencyMs,
        error: `Stellar Horizon returned ${response.status}: ${response.statusText}`,
        details: { url: horizonUrl, statusCode: response.status }
      };
    }

    return {
      status: latencyMs > 2000 ? 'degraded' : 'up',
      latencyMs,
      details: { url: horizonUrl, statusCode: response.status }
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    return {
      status: 'down',
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
      details: { url: horizonUrl }
    };
  }
};

/**
 * @notice Memory usage health check
 * @dev Monitors Node.js process memory usage against configured thresholds
 * @param thresholdMb Memory threshold in megabytes
 * @return ComponentHealth with memory usage details
 */
export const checkMemoryHealth = (
  thresholdMb: number = DEFAULT_CONFIG.memoryThresholdMb
): ComponentHealth => {
  const memUsage = process.memoryUsage();
  const heapUsedMb = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMb = Math.round(memUsage.heapTotal / 1024 / 1024);
  
  const status = heapUsedMb > thresholdMb ? 'degraded' : 'up';
  
  return {
    status,
    details: {
      heapUsedMb,
      heapTotalMb,
      thresholdMb,
      rss: Math.round(memUsage.rss / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024),
    }
  };
};

/**
 * @notice Comprehensive health check handler
 * @dev Performs all health checks and returns detailed status
 * @security Rate limited to prevent abuse - implement rate limiting middleware
 * @param pool Database connection pool
 * @param config Health check configuration
 * @return Express handler function
 */
export const healthHandler = (
  pool: Pool,
  config: Partial<HealthCheckConfig> = {}
) => async (req: Request, res: Response): Promise<void> => {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();
  
  try {
    // Perform all health checks in parallel for efficiency
    const [dbHealth, stellarHealth, memoryHealth] = await Promise.all([
      checkDatabaseHealth(pool, fullConfig.dbTimeoutMs),
      checkStellarHealth(fullConfig.stellarTimeoutMs),
      Promise.resolve(checkMemoryHealth(fullConfig.memoryThresholdMb)),
    ]);

    // Determine overall system status
    const allChecks = [dbHealth, stellarHealth, memoryHealth];
    const hasDown = allChecks.some(check => check.status === 'down');
    const hasDegraded = allChecks.some(check => check.status === 'degraded');
    
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
    if (hasDown) {
      overallStatus = 'unhealthy';
    } else if (hasDegraded) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'healthy';
    }

    const response: HealthCheckResponse = {
      status: overallStatus,
      service: 'revora-backend',
      version: process.env.npm_package_version || '0.1.0',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      checks: {
        database: dbHealth,
        stellar: stellarHealth,
        memory: memoryHealth,
      },
      requestId: (req as any).requestId,
    };

    // Set appropriate HTTP status code
    const statusCode = overallStatus === 'healthy' ? 200 : 
                      overallStatus === 'degraded' ? 200 : 503;
    
    res.status(statusCode).json(response);
  } catch (error) {
    // Handle unexpected errors in health check system
    const response: HealthCheckResponse = {
      status: 'unhealthy',
      service: 'revora-backend',
      version: process.env.npm_package_version || '0.1.0',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      checks: {
        database: { status: 'down', error: 'Health check system error' },
        stellar: { status: 'down', error: 'Health check system error' },
      },
      requestId: (req as any).requestId,
    };

    console.error('Health check system error:', error);
    res.status(503).json(response);
  }
};

/**
 * @notice Kubernetes-compatible readiness probe handler
 * @dev Simplified readiness check for container orchestration
 * @security No sensitive information exposed in readiness probe
 * @param pool Database connection pool
 * @return Express handler function
 */
export const readinessHandler = (pool: Pool) => async (req: Request, res: Response): Promise<void> => {
  try {
    // Only check critical dependencies for readiness
    const [dbHealth, stellarHealth] = await Promise.all([
      checkDatabaseHealth(pool, 3000), // Shorter timeout for readiness
      checkStellarHealth(2000),
    ]);

    const isReady = dbHealth.status !== 'down' && stellarHealth.status !== 'down';
    const failedChecks = [];
    
    if (dbHealth.status === 'down') failedChecks.push('database');
    if (stellarHealth.status === 'down') failedChecks.push('stellar');

    const response: ReadinessResponse = {
      ready: isReady,
      service: 'revora-backend',
      timestamp: new Date().toISOString(),
      checks: isReady ? ['database', 'stellar'] : failedChecks,
    };

    res.status(isReady ? 200 : 503).json(response);
  } catch (error) {
    console.error('Readiness check error:', error);
    res.status(503).json({
      ready: false,
      service: 'revora-backend',
      timestamp: new Date().toISOString(),
      checks: [],
    });
  }
};

/**
 * @notice Liveness probe handler for container orchestration
 * @dev Minimal check to verify process is alive and responsive
 * @security No external dependencies checked to avoid false positives
 * @return Express handler function
 */
export const livenessHandler = () => (_req: Request, res: Response): void => {
  // Simple liveness check - just verify the process is responsive
  res.status(200).json({
    alive: true,
    service: 'revora-backend',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });
};

/**
 * @notice Create health router with all health endpoints
 * @dev Provides comprehensive health monitoring endpoints
 * @param pool Database connection pool
 * @param config Optional health check configuration
 * @return Express router with health endpoints
 */
export const createHealthRouter = (
  pool: Pool,
  config: Partial<HealthCheckConfig> = {}
): Router => {
  const router = Router();
  
  // Comprehensive health check endpoint
  router.get('/health', healthHandler(pool, config));
  
  // Kubernetes readiness probe
  router.get('/ready', readinessHandler(pool));
  
  // Kubernetes liveness probe
  router.get('/live', livenessHandler());
  
  return router;
};

export default createHealthRouter;