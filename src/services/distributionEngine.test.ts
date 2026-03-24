import DistributionEngine from './distributionEngine';

describe('DistributionEngine', () => {
  // Mock distributionRepo that records created runs and payouts
  class MockDistributionRepo {
    runs: any[] = [];
    payouts: any[] = [];
    failNext = 0;
    failCount = 0;

    async createDistributionRun(input: any) {
      if (this.failNext > 0) {
        this.failNext--;
        this.failCount++;
        throw new Error('Database error (run)');
      }
      const run = { id: `run-${this.runs.length + 1}`, ...input };
      this.runs.push(run);
      return run;
    }

    async createPayout(input: any) {
      if (this.failNext > 0) {
        this.failNext--;
        this.failCount++;
        throw new Error('Database error (payout)');
      }
      const p = { id: `p-${this.payouts.length + 1}`, ...input };
      this.payouts.push(p);
      return p;
    }
  }

  // Mock balance provider
  class MockBalanceProvider {
    failNext = 0;
    failCount = 0;
    constructor(private rows: any[]) {}
    async getBalances(_offeringId: string, _period: any) {
      if (this.failNext > 0) {
        this.failNext--;
        this.failCount++;
        throw new Error('Balance provider error');
      }
      return this.rows;
    }
  }

  it('should distribute revenue prorated by balances', async () => {
    const distRepo = new MockDistributionRepo();
    const balances = [
      { investor_id: 'i1', balance: 70 },
      { investor_id: 'i2', balance: 30 },
    ];
    const engine = new DistributionEngine(null, distRepo, new MockBalanceProvider(balances));
    const res = await engine.distribute('off-1', { start: new Date(), end: new Date() }, 100);
    
    expect(res.payouts.length).toBe(2);
    const a1 = res.payouts.find((p) => p.investor_id === 'i1')!;
    const a2 = res.payouts.find((p) => p.investor_id === 'i2')!;
    expect(a1.amount).toBe('70.00');
    expect(a2.amount).toBe('30.00');
  });

  it('should handle rounding by adjusting the largest share', async () => {
    const distRepo = new MockDistributionRepo();
    const balances = [
      { investor_id: 'i1', balance: 1 },
      { investor_id: 'i2', balance: 1 },
      { investor_id: 'i3', balance: 1 },
    ];
    const engine = new DistributionEngine(null, distRepo, new MockBalanceProvider(balances));
    const res = await engine.distribute('off-2', { start: new Date(), end: new Date() }, 100);
    
    const sum = res.payouts.reduce((s, p) => s + Number(p.amount), 0);
    expect(sum).toBeCloseTo(100, 2);
    
    // One should be 33.34 and others 33.33
    const counts = res.payouts.reduce((acc, p) => {
      acc[p.amount] = (acc[p.amount] || 0) + 1;
      return acc;
    }, {} as any);
    expect(counts['33.34']).toBe(1);
    expect(counts['33.33']).toBe(2);
  });

  it('should retry fetching balances on transient failure', async () => {
    const distRepo = new MockDistributionRepo();
    const balances = [{ investor_id: 'i1', balance: 100 }];
    const provider = new MockBalanceProvider(balances);
    provider.failNext = 2; // Fail twice, succeed on 3rd

    const engine = new DistributionEngine(null, distRepo, provider, {
      maxRetries: 3,
      initialDelayMs: 1,
    });

    const res = await engine.distribute('off-retry-bal', { start: new Date(), end: new Date() }, 100);
    expect(res.payouts[0].amount).toBe('100.00');
    expect(provider.failCount).toBe(2);
  });

  it('should retry creating distribution run on transient failure', async () => {
    const distRepo = new MockDistributionRepo();
    distRepo.failNext = 2;
    const balances = [{ investor_id: 'i1', balance: 100 }];
    const engine = new DistributionEngine(null, distRepo, new MockBalanceProvider(balances), {
      maxRetries: 3,
      initialDelayMs: 1,
    });

    const res = await engine.distribute('off-retry-run', { start: new Date(), end: new Date() }, 100);
    expect(res.distributionRun.id).toBe('run-1');
    expect(distRepo.failCount).toBe(2);
  });

  it('should retry creating payouts on transient failure', async () => {
    const distRepo = new MockDistributionRepo();
    const balances = [{ investor_id: 'i1', balance: 100 }];
    const engine = new DistributionEngine(null, distRepo, new MockBalanceProvider(balances), {
      maxRetries: 3,
      initialDelayMs: 1,
    });

    // Succeed on run creation, fail on 1st payout
    const originalCreateRun = distRepo.createDistributionRun.bind(distRepo);
    distRepo.createDistributionRun = async (input: any) => {
      const run = await originalCreateRun(input);
      distRepo.failNext = 2; // Fail next 2 calls (which will be createPayout)
      return run;
    };

    const res = await engine.distribute('off-retry-payout', { start: new Date(), end: new Date() }, 100);
    expect(res.payouts.length).toBe(1);
    expect(distRepo.failCount).toBe(2);
  });

  it('should throw error after max retries exceeded (run)', async () => {
    const distRepo = new MockDistributionRepo();
    distRepo.failNext = 5;
    const balances = [{ investor_id: 'i1', balance: 100 }];
    const engine = new DistributionEngine(null, distRepo, new MockBalanceProvider(balances), {
      maxRetries: 3,
      initialDelayMs: 1,
    });

    await expect(
      engine.distribute('off-fail', { start: new Date(), end: new Date() }, 100)
    ).rejects.toThrow(/Failed to create distribution run after 3 attempts/);
  });

  it('should throw error after max retries exceeded (balances)', async () => {
    const provider = new MockBalanceProvider([]);
    provider.failNext = 5;
    const engine = new DistributionEngine(null, null, provider, {
      maxRetries: 2,
      initialDelayMs: 1,
    });

    await expect(
      engine.distribute('off-fail-bal', { start: new Date(), end: new Date() }, 100)
    ).rejects.toThrow(/Failed to acquire balances after 2 attempts/);
  });

  it('should throw error after max retries exceeded (payout)', async () => {
    const distRepo = new MockDistributionRepo();
    const balances = [{ investor_id: 'i1', balance: 100 }];
    const engine = new DistributionEngine(null, distRepo, new MockBalanceProvider(balances), {
      maxRetries: 2,
      initialDelayMs: 1,
    });

    // Succeed on run creation, fail on 1st payout
    const originalCreateRun = distRepo.createDistributionRun.bind(distRepo);
    distRepo.createDistributionRun = async (input: any) => {
      const run = await originalCreateRun(input);
      distRepo.failNext = 5; 
      return run;
    };

    await expect(
      engine.distribute('off-fail-payout', { start: new Date(), end: new Date() }, 100)
    ).rejects.toThrow(/Failed to create payout for investor i1 after 2 attempts/);
  });

  it('should log retries when logRetries is enabled', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    const distRepo = new MockDistributionRepo();
    distRepo.failNext = 1;
    const balances = [{ investor_id: 'i1', balance: 100 }];
    const engine = new DistributionEngine(null, distRepo, new MockBalanceProvider(balances), {
      maxRetries: 2,
      initialDelayMs: 1,
      logRetries: true,
    });

    await engine.distribute('off-log', { start: new Date(), end: new Date() }, 100);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Retry attempt 1 failed'));
    consoleSpy.mockRestore();
  });

  it('should validate inputs', async () => {
    const engine = new DistributionEngine(null, null);
    
    await expect(
      engine.distribute('', { start: new Date(), end: new Date() }, 100)
    ).rejects.toThrow('offeringId is required');

    await expect(
      engine.distribute('off-1', { start: new Date(), end: new Date() }, 0)
    ).rejects.toThrow('revenueAmount must be > 0');

    await expect(
      engine.distribute('off-1', null as any, 100)
    ).rejects.toThrow('Valid distribution period is required');
  });

  it('should throw if no balance source is available', async () => {
    const engine = new DistributionEngine(null, null);
    await expect(
      engine.distribute('off-1', { start: new Date(), end: new Date() }, 100)
    ).rejects.toThrow(/No balance source available/);
  });

  it('should throw if total balance is zero', async () => {
    const balances = [{ investor_id: 'i1', balance: 0 }];
    const engine = new DistributionEngine(null, null, new MockBalanceProvider(balances));
    await expect(
      engine.distribute('off-1', { start: new Date(), end: new Date() }, 100)
    ).rejects.toThrow('Total balance must be > 0 to distribute revenue');
  });

  it('should support offeringRepo.getInvestors', async () => {
    const mockRepo = {
      getInvestors: jest.fn().mockResolvedValue([{ investor_id: 'i1', balance: 100 }])
    };
    const distRepo = new MockDistributionRepo();
    const engine = new DistributionEngine(mockRepo, distRepo);
    const res = await engine.distribute('off-1', { start: new Date(), end: new Date() }, 100);
    expect(res.payouts[0].investor_id).toBe('i1');
    expect(mockRepo.getInvestors).toHaveBeenCalled();
  });

  it('should support offeringRepo.listInvestors', async () => {
    const mockRepo = {
      listInvestors: jest.fn().mockResolvedValue([{ investor_id: 'i2', balance: 200 }])
    };
    const distRepo = new MockDistributionRepo();
    const engine = new DistributionEngine(mockRepo, distRepo);
    const res = await engine.distribute('off-1', { start: new Date(), end: new Date() }, 100);
    expect(res.payouts[0].investor_id).toBe('i2');
    expect(mockRepo.listInvestors).toHaveBeenCalled();
  });
});
