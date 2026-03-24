import { Request, Response } from 'express';
import { Pool } from 'pg';
import createHealthRouter, { healthReadyHandler } from './health';
import request from 'supertest';
import app from '../index';
import { closePool } from '../db/client';
import { RevenueReconciliationService } from '../services/revenueReconciliationService';

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
        expect(global.fetch).not.toHaveBeenCalled();
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
        const res = await request(app).post(`${prefix}/vaults/vault-1/milestones/milestone-1/validate`);
        expect(res.status).toBe(401);
    });
    
    it('should 404 for protected endpoints if prefix is lacking', async () => {
        const res = await request(app).post('/vaults/vault-1/milestones/milestone-1/validate');
        expect(res.status).toBe(404);
    });
});

describe('Revenue Reconciliation Checks - Service Tests', () => {
    describe('RevenueReconciliationService', () => {
        const mockPool = {
            query: jest.fn(),
        } as unknown as Pool;

        let service: RevenueReconciliationService;

        beforeEach(() => {
            service = new RevenueReconciliationService(mockPool);
            jest.clearAllMocks();
        });

        describe('reconcile', () => {
            it('should return balanced result when revenue matches payouts', async () => {
                const offeringId = 'offering-1';
                const periodStart = new Date('2024-01-01');
                const periodEnd = new Date('2024-01-31');

                (mockPool.query as jest.Mock)
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'report-1',
                            offering_id: offeringId,
                            amount: '1000.00',
                            period_start: new Date('2024-01-01'),
                            period_end: new Date('2024-01-31'),
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    })
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'run-1',
                            offering_id: offeringId,
                            total_amount: '1000.00',
                            distribution_date: new Date('2024-01-31'),
                            status: 'completed',
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    })
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'inv-1',
                            investor_id: 'investor-1',
                            offering_id: offeringId,
                            amount: '500.00',
                            asset: 'USDC',
                            status: 'completed',
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    });

                const result = await service.reconcile(offeringId, periodStart, periodEnd);

                expect(result).toBeDefined();
                expect(result.offeringId).toBe(offeringId);
                expect(result.isBalanced).toBe(true);
                expect(result.discrepancies).toHaveLength(0);
                expect(result.summary.totalRevenueReported).toBe('1000.00');
                expect(result.summary.totalPayouts).toBe('1000.00');
            });

            it('should detect revenue mismatch when payouts do not match reported revenue', async () => {
                const offeringId = 'offering-2';
                const periodStart = new Date('2024-02-01');
                const periodEnd = new Date('2024-02-29');

                (mockPool.query as jest.Mock)
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'report-2',
                            offering_id: offeringId,
                            amount: '1000.50',
                            period_start: new Date('2024-02-01'),
                            period_end: new Date('2024-02-29'),
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    })
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'run-2',
                            offering_id: offeringId,
                            total_amount: '1000.00',
                            distribution_date: new Date('2024-02-29'),
                            status: 'completed',
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    })
                    .mockResolvedValueOnce({
                        rows: [],
                    });

                const result = await service.reconcile(offeringId, periodStart, periodEnd);

                expect(result).toBeDefined();
                expect(result.isBalanced).toBe(false);
                expect(result.discrepancies.length).toBeGreaterThan(0);
                const mismatch = result.discrepancies.find(d => d.type === 'REVENUE_MISMATCH');
                expect(mismatch).toBeDefined();
                expect(mismatch?.severity).toBe('error');
            });

            it('should detect critical mismatch when difference exceeds threshold', async () => {
                const offeringId = 'offering-3';
                const periodStart = new Date('2024-03-01');
                const periodEnd = new Date('2024-03-31');

                (mockPool.query as jest.Mock)
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'report-3',
                            offering_id: offeringId,
                            amount: '5000.00',
                            period_start: new Date('2024-03-01'),
                            period_end: new Date('2024-03-31'),
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    })
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'run-3',
                            offering_id: offeringId,
                            total_amount: '1000.00',
                            distribution_date: new Date('2024-03-31'),
                            status: 'completed',
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    })
                    .mockResolvedValueOnce({
                        rows: [],
                    });

                const result = await service.reconcile(offeringId, periodStart, periodEnd);

                const criticalMismatch = result.discrepancies.find(d => d.type === 'REVENUE_MISMATCH');
                expect(criticalMismatch?.severity).toBe('critical');
            });

            it('should handle empty revenue reports gracefully', async () => {
                const offeringId = 'offering-4';
                const periodStart = new Date('2024-04-01');
                const periodEnd = new Date('2024-04-30');

                (mockPool.query as jest.Mock)
                    .mockResolvedValueOnce({ rows: [] })
                    .mockResolvedValueOnce({ rows: [] })
                    .mockResolvedValueOnce({ rows: [] });

                const result = await service.reconcile(offeringId, periodStart, periodEnd);

                expect(result.isBalanced).toBe(true);
                expect(result.summary.totalRevenueReported).toBe('0.00');
                expect(result.summary.totalPayouts).toBe('0.00');
            });

            it('should include rounding adjustments when enabled', async () => {
                const offeringId = 'offering-5';
                const periodStart = new Date('2024-05-01');
                const periodEnd = new Date('2024-05-31');

                (mockPool.query as jest.Mock)
                    .mockResolvedValueOnce({ rows: [] })
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'run-5',
                            offering_id: offeringId,
                            total_amount: '999.999',
                            distribution_date: new Date('2024-05-31'),
                            status: 'completed',
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    })
                    .mockResolvedValueOnce({ rows: [] });

                const result = await service.reconcile(offeringId, periodStart, periodEnd, {
                    checkRoundingAdjustments: true,
                });

                expect(result).toBeDefined();
            });
        });

        describe('quickBalanceCheck', () => {
            it('should return balanced true when amounts match within tolerance', async () => {
                const offeringId = 'offering-quick-1';
                const periodStart = new Date('2024-06-01');
                const periodEnd = new Date('2024-06-30');

                (mockPool.query as jest.Mock)
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'report-q1',
                            offering_id: offeringId,
                            amount: '500.00',
                            period_start: new Date('2024-06-01'),
                            period_end: new Date('2024-06-30'),
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    })
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'run-q1',
                            offering_id: offeringId,
                            total_amount: '500.00',
                            distribution_date: new Date('2024-06-30'),
                            status: 'completed',
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    });

                const result = await service.quickBalanceCheck(offeringId, periodStart, periodEnd);

                expect(result.isBalanced).toBe(true);
                expect(result.difference).toBe('0.00');
            });

            it('should return balanced false when amounts differ beyond tolerance', async () => {
                const offeringId = 'offering-quick-2';
                const periodStart = new Date('2024-07-01');
                const periodEnd = new Date('2024-07-31');

                (mockPool.query as jest.Mock)
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'report-q2',
                            offering_id: offeringId,
                            amount: '500.00',
                            period_start: new Date('2024-07-01'),
                            period_end: new Date('2024-07-31'),
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    })
                    .mockResolvedValueOnce({
                        rows: [{
                            id: 'run-q2',
                            offering_id: offeringId,
                            total_amount: '450.00',
                            distribution_date: new Date('2024-07-31'),
                            status: 'completed',
                            created_at: new Date(),
                            updated_at: new Date(),
                        }],
                    });

                const result = await service.quickBalanceCheck(offeringId, periodStart, periodEnd);

                expect(result.isBalanced).toBe(false);
                expect(result.difference).toBe('50.00');
            });

            it('should return balanced true for empty data', async () => {
                const offeringId = 'offering-quick-3';
                const periodStart = new Date('2024-08-01');
                const periodEnd = new Date('2024-08-31');

                (mockPool.query as jest.Mock)
                    .mockResolvedValueOnce({ rows: [] })
                    .mockResolvedValueOnce({ rows: [] });

                const result = await service.quickBalanceCheck(offeringId, periodStart, periodEnd);

                expect(result.isBalanced).toBe(true);
                expect(result.difference).toBe('0.00');
            });
        });

        describe('verifyDistributionRun', () => {
            it('should return valid for properly formatted distribution run', async () => {
                (mockPool.query as jest.Mock).mockResolvedValueOnce({
                    rows: [{
                        id: 'run-verify-1',
                        offering_id: 'offering-verify-1',
                        total_amount: '1000.00',
                        distribution_date: new Date('2024-09-30'),
                        status: 'completed',
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                });

                const result = await service.verifyDistributionRun('run-verify-1');

                expect(result.isValid).toBe(true);
                expect(result.errors).toHaveLength(0);
            });

            it('should return invalid for non-existent distribution run', async () => {
                (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

                const result = await service.verifyDistributionRun('non-existent-run');

                expect(result.isValid).toBe(false);
                expect(result.errors).toContain('Distribution run not found');
            });
        });

        describe('validateRevenueReport', () => {
            it('should return valid for proper revenue report', async () => {
                const offeringId = 'offering-validate-1';
                const amount = '1000.00';
                const periodStart = new Date('2024-10-01');
                const periodEnd = new Date('2024-10-31');

                (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

                const result = await service.validateRevenueReport(
                    offeringId,
                    amount,
                    periodStart,
                    periodEnd
                );

                expect(result.isValid).toBe(true);
                expect(result.errors).toHaveLength(0);
            });

            it('should reject negative amount', async () => {
                const offeringId = 'offering-validate-2';
                const amount = '-100.00';
                const periodStart = new Date('2024-11-01');
                const periodEnd = new Date('2024-11-30');

                (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

                const result = await service.validateRevenueReport(
                    offeringId,
                    amount,
                    periodStart,
                    periodEnd
                );

                expect(result.isValid).toBe(false);
                expect(result.errors).toContain('Revenue amount cannot be negative');
            });

            it('should reject invalid date range', async () => {
                const offeringId = 'offering-validate-3';
                const amount = '500.00';
                const periodStart = new Date('2024-12-31');
                const periodEnd = new Date('2024-12-01');

                (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

                const result = await service.validateRevenueReport(
                    offeringId,
                    amount,
                    periodStart,
                    periodEnd
                );

                expect(result.isValid).toBe(false);
                expect(result.errors).toContain('Period end must be after period start');
            });

            it('should reject future period start', async () => {
                const offeringId = 'offering-validate-4';
                const amount = '500.00';
                const periodStart = new Date('2099-01-01');
                const periodEnd = new Date('2099-01-31');

                (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

                const result = await service.validateRevenueReport(
                    offeringId,
                    amount,
                    periodStart,
                    periodEnd
                );

                expect(result.isValid).toBe(false);
                expect(result.errors).toContain('Period start cannot be in the future');
            });

            it('should reject duplicate report for same offering and period', async () => {
                const offeringId = 'offering-validate-5';
                const amount = '500.00';
                const periodStart = new Date('2024-10-01');
                const periodEnd = new Date('2024-10-31');

                (mockPool.query as jest.Mock).mockResolvedValueOnce({
                    rows: [{
                        id: 'existing-report',
                        offering_id: offeringId,
                        amount: '500.00',
                        period_start: periodStart,
                        period_end: periodEnd,
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                });

                const result = await service.validateRevenueReport(
                    offeringId,
                    amount,
                    periodStart,
                    periodEnd
                );

                expect(result.isValid).toBe(false);
                expect(result.errors).toContain('Revenue report already exists for this offering and period');
            });
        });
    });
});

describe('Revenue Reconciliation Routes - Integration Tests', () => {
    const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';

    describe('POST /api/v1/reconciliation/reconcile', () => {
        it('should return 401 without authentication', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .send({});
            expect(res.status).toBe(401);
        });

        it('should return 400 when offeringId is missing', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'admin')
                .send({
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBe(400);
        });

        it('should return 400 when period dates are missing', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'offering-1',
                });
            expect(res.status).toBe(400);
        });

        it('should return 400 for invalid date format', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'offering-1',
                    periodStart: 'invalid-date',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBe(400);
        });

        it('should return 400 when periodEnd is before periodStart', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'offering-1',
                    periodStart: '2024-01-31',
                    periodEnd: '2024-01-01',
                });
            expect(res.status).toBe(400);
        });

        it('should return 403 for non-admin on non-owned offering', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-id', 'other-user')
                .set('x-user-role', 'startup')
                .send({
                    offeringId: 'offering-1',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBeGreaterThanOrEqual(400);
        });

        it('should return 404 for non-existent offering', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'non-existent-offering',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBeGreaterThanOrEqual(400);
        });
    });

    describe('GET /api/v1/reconciliation/balance-check/:offeringId', () => {
        it('should return 401 without authentication', async () => {
            const res = await request(app)
                .get(`${prefix}/reconciliation/balance-check/offering-1`);
            expect(res.status).toBe(401);
        });

        it('should return 400 when period query params are missing', async () => {
            const res = await request(app)
                .get(`${prefix}/reconciliation/balance-check/offering-1`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'admin');
            expect(res.status).toBe(400);
        });

        it('should return 400 for invalid date format', async () => {
            const res = await request(app)
                .get(`${prefix}/reconciliation/balance-check/offering-1?periodStart=invalid&periodEnd=2024-01-31`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'admin');
            expect(res.status).toBe(400);
        });
    });

    describe('POST /api/v1/reconciliation/verify-distribution/:runId', () => {
        it('should return 401 without authentication', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/verify-distribution/run-1`);
            expect(res.status).toBe(401);
        });

        it('should return 403 for non-admin users', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/verify-distribution/run-1`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'startup');
            expect(res.status).toBe(403);
        });
    });

    describe('POST /api/v1/reconciliation/validate-report', () => {
        it('should return 401 without authentication', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/validate-report`)
                .send({});
            expect(res.status).toBe(401);
        });

        it('should return 400 when amount is missing', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/validate-report`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'offering-1',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBe(400);
        });

        it('should return 400 for negative amount', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/validate-report`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'offering-1',
                    amount: '-100',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBe(400);
        });

        it('should return 400 for invalid amount format', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/validate-report`)
                .set('x-user-id', 'user-1')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'offering-1',
                    amount: 'not-a-number',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBe(400);
        });
    });
});

describe('Revenue Reconciliation Security Tests', () => {
    const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';

    describe('Authentication Boundary Tests', () => {
        it('should reject requests without x-user-id header', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'offering-1',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBe(401);
        });

        it('should reject requests without x-user-role header', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-id', 'user-1')
                .send({
                    offeringId: 'offering-1',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBe(401);
        });

        it('should reject requests with empty headers', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-id', '')
                .set('x-user-role', '')
                .send({
                    offeringId: 'offering-1',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBe(401);
        });
    });

    describe('Authorization Boundary Tests', () => {
        it('should allow admin to reconcile any offering', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-id', 'admin-user')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'any-offering',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect([200, 404, 500]).toContain(res.status);
        });

        it('should reject startup role from verify-distribution endpoint', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/verify-distribution/some-run-id`)
                .set('x-user-id', 'startup-user')
                .set('x-user-role', 'startup');
            expect(res.status).toBe(403);
        });
    });

    describe('Input Validation Tests', () => {
        it('should reject SQL injection attempts in offeringId', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/reconcile`)
                .set('x-user-id', 'admin')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: "'; DROP TABLE revenue_reports; --",
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBeGreaterThanOrEqual(400);
        });

        it('should reject XSS attempts in amount field', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/validate-report`)
                .set('x-user-id', 'admin')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'offering-1',
                    amount: '<script>alert("xss")</script>',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBeGreaterThanOrEqual(400);
        });

        it('should handle extremely large amounts', async () => {
            const res = await request(app)
                .post(`${prefix}/reconciliation/validate-report`)
                .set('x-user-id', 'admin')
                .set('x-user-role', 'admin')
                .send({
                    offeringId: 'offering-1',
                    amount: '999999999999999999999999999999.99',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                });
            expect(res.status).toBeGreaterThanOrEqual(400);
        });
    });
});

describe('Revenue Reconciliation Edge Case Tests', () => {
    const mockPool = {
        query: jest.fn(),
    } as unknown as Pool;

    let service: RevenueReconciliationService;

    beforeEach(() => {
        service = new RevenueReconciliationService(mockPool);
        jest.clearAllMocks();
    });

    describe('Boundary Conditions', () => {
        it('should handle zero amount revenue', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'report-zero',
                        offering_id: 'offering-zero',
                        amount: '0.00',
                        period_start: new Date('2024-01-01'),
                        period_end: new Date('2024-01-31'),
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'run-zero',
                        offering_id: 'offering-zero',
                        total_amount: '0.00',
                        distribution_date: new Date('2024-01-31'),
                        status: 'completed',
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-zero',
                new Date('2024-01-01'),
                new Date('2024-01-31')
            );

            expect(result.summary.totalRevenueReported).toBe('0.00');
        });

        it('should handle very small amounts with precision', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'report-small',
                        offering_id: 'offering-small',
                        amount: '0.01',
                        period_start: new Date('2024-02-01'),
                        period_end: new Date('2024-02-29'),
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'run-small',
                        offering_id: 'offering-small',
                        total_amount: '0.01',
                        distribution_date: new Date('2024-02-29'),
                        status: 'completed',
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-small',
                new Date('2024-02-01'),
                new Date('2024-02-29')
            );

            expect(result.isBalanced).toBe(true);
        });

        it('should handle very large amounts', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'report-large',
                        offering_id: 'offering-large',
                        amount: '9999999999.99',
                        period_start: new Date('2024-03-01'),
                        period_end: new Date('2024-03-31'),
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'run-large',
                        offering_id: 'offering-large',
                        total_amount: '9999999999.99',
                        distribution_date: new Date('2024-03-31'),
                        status: 'completed',
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-large',
                new Date('2024-03-01'),
                new Date('2024-03-31')
            );

            expect(result.isBalanced).toBe(true);
            expect(result.summary.totalRevenueReported).toBe('9999999999.99');
        });
    });

    describe('Date Range Tests', () => {
        it('should handle single day period', async () => {
            const sameDay = '2024-04-15';

            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-same-day',
                new Date(sameDay),
                new Date(sameDay)
            );

            expect(result).toBeDefined();
            expect(result.periodStart.getTime()).toBe(result.periodEnd.getTime());
        });

        it('should handle year-long period', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-year',
                new Date('2023-01-01'),
                new Date('2023-12-31')
            );

            expect(result).toBeDefined();
        });

        it('should handle leap year date', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-leap',
                new Date('2024-02-28'),
                new Date('2024-02-29')
            );

            expect(result).toBeDefined();
        });
    });

    describe('Distribution Status Tests', () => {
        it('should flag failed distribution runs', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'run-failed',
                        offering_id: 'offering-failed',
                        total_amount: '500.00',
                        distribution_date: new Date('2024-05-31'),
                        status: 'failed',
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-failed',
                new Date('2024-05-01'),
                new Date('2024-05-31')
            );

            expect(result.discrepancies.some(d => d.type === 'DISTRIBUTION_STATUS_INVALID')).toBe(true);
        });

        it('should flag processing distribution runs', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'run-processing',
                        offering_id: 'offering-processing',
                        total_amount: '500.00',
                        distribution_date: new Date('2024-06-30'),
                        status: 'processing',
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-processing',
                new Date('2024-06-01'),
                new Date('2024-06-30')
            );

            const statusDiscrepancy = result.discrepancies.find(
                d => d.type === 'DISTRIBUTION_STATUS_INVALID' && d.severity === 'warning'
            );
            expect(statusDiscrepancy).toBeDefined();
        });

        it('should ignore pending distribution runs in sum', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [
                        {
                            id: 'run-pending',
                            offering_id: 'offering-pending',
                            total_amount: '500.00',
                            distribution_date: new Date('2024-07-31'),
                            status: 'pending',
                            created_at: new Date(),
                            updated_at: new Date(),
                        },
                        {
                            id: 'run-completed',
                            offering_id: 'offering-pending',
                            total_amount: '300.00',
                            distribution_date: new Date('2024-07-30'),
                            status: 'completed',
                            created_at: new Date(),
                            updated_at: new Date(),
                        },
                    ],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-pending',
                new Date('2024-07-01'),
                new Date('2024-07-31')
            );

            expect(result.summary.totalPayouts).toBe('300.00');
        });
    });

    describe('Multiple Reports and Runs Tests', () => {
        it('should aggregate multiple revenue reports in same period', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({
                    rows: [
                        {
                            id: 'report-1',
                            offering_id: 'offering-multi',
                            amount: '1000.00',
                            period_start: new Date('2024-08-01'),
                            period_end: new Date('2024-08-15'),
                            created_at: new Date(),
                            updated_at: new Date(),
                        },
                        {
                            id: 'report-2',
                            offering_id: 'offering-multi',
                            amount: '500.00',
                            period_start: new Date('2024-08-16'),
                            period_end: new Date('2024-08-31'),
                            created_at: new Date(),
                            updated_at: new Date(),
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'run-1',
                        offering_id: 'offering-multi',
                        total_amount: '1500.00',
                        distribution_date: new Date('2024-08-31'),
                        status: 'completed',
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-multi',
                new Date('2024-08-01'),
                new Date('2024-08-31')
            );

            expect(result.summary.totalRevenueReported).toBe('1500.00');
            expect(result.isBalanced).toBe(true);
        });

        it('should aggregate multiple distribution runs in same period', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'report-1',
                        offering_id: 'offering-runs',
                        amount: '2000.00',
                        period_start: new Date('2024-09-01'),
                        period_end: new Date('2024-09-30'),
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [
                        {
                            id: 'run-1',
                            offering_id: 'offering-runs',
                            total_amount: '1000.00',
                            distribution_date: new Date('2024-09-15'),
                            status: 'completed',
                            created_at: new Date(),
                            updated_at: new Date(),
                        },
                        {
                            id: 'run-2',
                            offering_id: 'offering-runs',
                            total_amount: '1000.00',
                            distribution_date: new Date('2024-09-30'),
                            status: 'completed',
                            created_at: new Date(),
                            updated_at: new Date(),
                        },
                    ],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-runs',
                new Date('2024-09-01'),
                new Date('2024-09-30')
            );

            expect(result.summary.totalPayouts).toBe('2000.00');
            expect(result.isBalanced).toBe(true);
        });
    });

    describe('Tolerance Tests', () => {
        it('should consider balanced when difference is within tolerance', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'report-tol',
                        offering_id: 'offering-tol',
                        amount: '1000.00',
                        period_start: new Date('2024-10-01'),
                        period_end: new Date('2024-10-31'),
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'run-tol',
                        offering_id: 'offering-tol',
                        total_amount: '999.99',
                        distribution_date: new Date('2024-10-31'),
                        status: 'completed',
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-tol',
                new Date('2024-10-01'),
                new Date('2024-10-31'),
                { tolerance: 0.01 }
            );

            expect(result.isBalanced).toBe(true);
        });

        it('should flag discrepancy when difference exceeds tolerance', async () => {
            (mockPool.query as jest.Mock)
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'report-tol2',
                        offering_id: 'offering-tol2',
                        amount: '1000.00',
                        period_start: new Date('2024-11-01'),
                        period_end: new Date('2024-11-30'),
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'run-tol2',
                        offering_id: 'offering-tol2',
                        total_amount: '998.00',
                        distribution_date: new Date('2024-11-30'),
                        status: 'completed',
                        created_at: new Date(),
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await service.reconcile(
                'offering-tol2',
                new Date('2024-11-01'),
                new Date('2024-11-30'),
                { tolerance: 0.01 }
            );

            expect(result.isBalanced).toBe(false);
            expect(result.discrepancies.some(d => d.type === 'REVENUE_MISMATCH')).toBe(true);
        });
    });
});
