import { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import app from '../index';
import { closePool } from '../db/client';
import { AppError, ErrorCode } from '../lib/errors';
import { errorHandler } from '../middleware/errorHandler';
import {
  createHealthRouter,
  healthReadyHandler,
  mapHealthDependencyFailure,
} from './health';

global.fetch = jest.fn();

function createResponseMocks(): {
  res: Partial<Response>;
  statusMock: jest.Mock;
  jsonMock: jest.Mock;
} {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });

  return {
    res: {
      status: statusMock,
      json: jsonMock,
    },
    statusMock,
    jsonMock,
  };
}

afterAll(async () => {
  await closePool();
});

describe('mapHealthDependencyFailure', () => {
  it('returns a sanitized service-unavailable error for database failures', () => {
    const mapped = mapHealthDependencyFailure('database', new Error('password auth failed'));

    expect(mapped.statusCode).toBe(503);
    expect(mapped.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(mapped.message).toBe('Dependency unavailable');
    expect(mapped.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: { dependency: 'database' },
    });
  });

  it('captures the upstream status for deterministic Stellar failures', () => {
    const mapped = mapHealthDependencyFailure('stellar-horizon', { status: 502 });

    expect(mapped.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: {
        dependency: 'stellar-horizon',
        upstreamStatus: 502,
      },
    });
  });
});

describe('createHealthRouter', () => {
  it('registers the ready route', () => {
    const router = createHealthRouter({ query: jest.fn() } as unknown as Pick<Pool, 'query'>);
    const routeLayer = (
      router as unknown as { stack: Array<{ route?: { path?: string } }> }
    ).stack.find((layer) => layer.route?.path);

    expect(routeLayer?.route?.path).toBe('/ready');
  });
});

describe('Health Router', () => {
  let mockPool: jest.Mocked<Pick<Pool, 'query'>>;
  let mockReq: Partial<Request>;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    };

    mockReq = {};
    next = jest.fn();
    jest.clearAllMocks();
    delete process.env.STELLAR_HORIZON_URL;
  });

  it('returns 200 when both DB and Stellar are up', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });
    const { res, statusMock, jsonMock } = createResponseMocks();

    const handler = healthReadyHandler(mockPool);
    await handler(mockReq as Request, res as Response, next);

    expect(mockPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(global.fetch).toHaveBeenCalledWith('https://horizon.stellar.org');
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'ok', db: 'up', stellar: 'up' });
    expect(next).not.toHaveBeenCalled();
  });

  it('uses the configured Horizon URL when provided', async () => {
    process.env.STELLAR_HORIZON_URL = 'https://custom.example/horizon';
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });
    const { res } = createResponseMocks();

    const handler = healthReadyHandler(mockPool);
    await handler(mockReq as Request, res as Response, next);

    expect(global.fetch).toHaveBeenCalledWith('https://custom.example/horizon');
  });

  it('forwards a structured database failure without probing Horizon', async () => {
    (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error('Connection timeout'));
    const { res } = createResponseMocks();

    const handler = healthReadyHandler(mockPool);
    await handler(mockReq as Request, res as Response, next);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);

    const err = next.mock.calls[0][0] as unknown as AppError;
    expect(err.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(err.statusCode).toBe(503);
    expect(err.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: { dependency: 'database' },
    });
  });

  it('forwards a structured Horizon network failure', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
    const { res } = createResponseMocks();

    const handler = healthReadyHandler(mockPool);
    await handler(mockReq as Request, res as Response, next);

    const err = next.mock.calls[0][0] as unknown as AppError;
    expect(err.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: { dependency: 'stellar-horizon' },
    });
  });

  it('forwards a structured Horizon non-OK failure with upstream status', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 503 });
    const { res } = createResponseMocks();

    const handler = healthReadyHandler(mockPool);
    await handler(mockReq as Request, res as Response, next);

    const err = next.mock.calls[0][0] as unknown as AppError;
    expect(err.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: { dependency: 'stellar-horizon', upstreamStatus: 503 },
    });
  });

  it('allows the global error handler to serialize health failures deterministically', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error('db broke'));
    const handler = healthReadyHandler(mockPool);
    const { res } = createResponseMocks();
    const nextErrors: unknown[] = [];

    await handler(
      mockReq as Request,
      res as Response,
      ((err?: unknown) => {
        if (err !== undefined) {
          nextErrors.push(err);
        }
      }) as NextFunction,
    );

    const { res: errorRes, statusMock, jsonMock } = createResponseMocks();
    errorHandler(
      nextErrors[0],
      { requestId: 'health-rid-1' } as Request,
      errorRes as unknown as Response,
      jest.fn(),
    );

    expect(statusMock).toHaveBeenCalledWith(503);
    expect(jsonMock).toHaveBeenCalledWith({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: { dependency: 'database' },
      requestId: 'health-rid-1',
    });

    consoleErrorSpy.mockRestore();
  });
});

describe('API Version Prefix Consistency tests', () => {
  it('should resolve /health without API prefix', async () => {
    const res = await request(app).get('/health');
    expect([200, 503]).toContain(res.status);
  });

  it('should resolve api routes with API_VERSION_PREFIX', async () => {
    const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
    const res = await request(app).get(`${prefix}/overview`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('name', 'Stellar RevenueShare (Revora) Backend');
  });

  it('should return 404 for api routes without prefix', async () => {
    const res = await request(app).get('/overview');
    expect(res.status).toBe(404);
  });

  it('should correctly scope protected endpoints under the prefix', async () => {
    const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
    const res = await request(app).post(
      `${prefix}/vaults/vault-1/milestones/milestone-1/validate`,
    );
    expect(res.status).toBe(401);
  });

  it('should 404 for protected endpoints if prefix is lacking', async () => {
    const res = await request(app).post('/vaults/vault-1/milestones/milestone-1/validate');
    expect(res.status).toBe(404);
  });
});
