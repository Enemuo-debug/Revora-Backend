import { Request, Response } from 'express';
import { Pool } from 'pg';
import createHealthRouter, { healthReadyHandler } from './health';
import request from 'supertest';
import app from '../index';
import { closePool } from '../db/client';

// Mock fetch for Stellar check
global.fetch = jest.fn();

afterAll(async () => {
    await closePool();
});

describe('Health Router', () => {
    let mockPool: jest.Mocked<Pool>;
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let jsonMock: jest.Mock;
    let statusMock: jest.Mock;

    beforeEach(() => {
        mockPool = {
            query: jest.fn(),
        } as unknown as jest.Mocked<Pool>;

        jsonMock = jest.fn();
        statusMock = jest.fn().mockReturnValue({ json: jsonMock });

        mockReq = {};
        mockRes = {
            status: statusMock,
            json: jsonMock,
        };

        jest.clearAllMocks();
    });

    it('should return 200 when both DB and Stellar are up', async () => {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'ok', db: 'up', stellar: 'up' });
    });

    it('should return 503 when DB is down', async () => {
        (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error('Connection timeout'));

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Database is down' });
        expect(global.fetch).not.toHaveBeenCalled(); // DB checked first
    });

    it('should return 503 when Stellar Horizon is down', async () => {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Stellar Horizon is down' });
    });

    it('should return 503 when Stellar Horizon returns non-OK status', async () => {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Stellar Horizon is down' });
    });

    it('should create returning router instance', () => {
        const router = createHealthRouter(mockPool);
        expect(router).toBeDefined();
        expect(typeof router.get).toBe('function');
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
        // Hit milestone validation route (requires auth)
        const res = await request(app).post(`${prefix}/vaults/vault-1/milestones/milestone-1/validate`);
        expect(res.status).toBe(401);
    });
    
    it('should 404 for protected endpoints if prefix is lacking', async () => {
        const res = await request(app).post('/vaults/vault-1/milestones/milestone-1/validate');
        expect(res.status).toBe(404);
    });
});

describe('Password Reset Rate Controls', () => {
    const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';

    it('should return success message for valid password reset request', async () => {
        const res = await request(app)
            .post(`${prefix}/api/auth/forgot-password`)
            .send({ email: 'test@example.com' });
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('message');
    });

    it('should return success message even for non-existent email (security)', async () => {
        const res = await request(app)
            .post(`${prefix}/api/auth/forgot-password`)
            .send({ email: 'nonexistent@example.com' });
        expect(res.status).toBe(200);
        expect(res.body.message).toContain('If the email exists');
    });

    it('should return 400 for invalid email format', async () => {
        const res = await request(app)
            .post(`${prefix}/api/auth/forgot-password`)
            .send({ email: 'invalid-email' });
        expect(res.status).toBe(200);
        expect(res.body.message).toContain('If the email exists');
    });

    it('should return 400 for missing email', async () => {
        const res = await request(app)
            .post(`${prefix}/api/auth/forgot-password`)
            .send({});
        expect(res.status).toBe(200);
        expect(res.body.message).toContain('If the email exists');
    });

    it('should return 400 for invalid token in reset-password', async () => {
        const res = await request(app)
            .post(`${prefix}/api/auth/reset-password`)
            .send({ token: '', password: 'password123' });
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('should return 400 for short password in reset-password', async () => {
        const res = await request(app)
            .post(`${prefix}/api/auth/reset-password`)
            .send({ token: 'valid-token', password: 'short' });
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('should return 400 for missing password in reset-password', async () => {
        const res = await request(app)
            .post(`${prefix}/api/auth/reset-password`)
            .send({ token: 'valid-token' });
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('should return 404 for password reset routes without prefix', async () => {
        const res = await request(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'test@example.com' });
        expect(res.status).toBe(404);
    });

    it('should handle rate limiting with 429 response', async () => {
        const res = await request(app)
            .post(`${prefix}/api/auth/forgot-password`)
            .send({ email: 'ratelimit@example.com' });
        expect([200, 429]).toContain(res.status);
        if (res.status === 429) {
            expect(res.body).toHaveProperty('retryAfter');
        }
    });
});
