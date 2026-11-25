import { DeadLetterService } from "../deadLetterService";

function makeMockTransactions(records: any[]) {
  return {
    findByStatus: async (status: string, limit: number) =>
      records.filter((r) => r.status === status).slice(0, limit),
    findById: async (id: string) => records.find((r) => r.id === id) ?? null,
    update: async (id: string, patch: any) => {
      const r = records.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    },
  };
}

function makeMockAdminService() {
  const logs: any[] = [];
  return {
    log: async (entry: any) => { logs.push(entry); },
    logs,
    verifyAndConsumeToken: async () => {},
  };
}

function makeMockOrchestrator(isPaidResult: boolean) {
  return { isPaid: async (_id: string) => isPaidResult };
}

describe("DeadLetterService", () => {
  it("lists only dead-status transactions", async () => {
    const records = [
      { id: "1", status: "dead", payoutId: "p1", attempts: 3, errorMessage: "err", updatedAt: new Date(), type: "payout", signedXdr: null },
      { id: "2", status: "pending", payoutId: "p2", attempts: 1, errorMessage: null, updatedAt: new Date(), type: "payout", signedXdr: null },
    ];
    const service = new DeadLetterService(
      makeMockTransactions(records) as any,
      makeMockAdminService() as any,
      makeMockOrchestrator(false) as any,
    );
    const result = await service.list();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("1");
  });

  it("re-drive returns already_paid when payout is on-chain", async () => {
    const records = [
      { id: "tx1", status: "dead", payoutId: "payout1", attempts: 3, errorMessage: "fail", updatedAt: new Date(), type: "payout", signedXdr: "xdr" },
    ];
    const adminSvc = makeMockAdminService();
    const service = new DeadLetterService(
      makeMockTransactions(records) as any,
      adminSvc as any,
      makeMockOrchestrator(true) as any,
    );
    const result = await service.redrive("tx1", "admin1");
    expect(result.status).toBe("already_paid");
    expect(adminSvc.logs[0].action).toBe("redrive_dead_letter");
  });

  it("re-drive requeues when not already paid", async () => {
    const records = [
      { id: "tx2", status: "dead", payoutId: "payout2", attempts: 3, errorMessage: "fail", updatedAt: new Date(), type: "payout", signedXdr: "xdr" },
    ];
    const service = new DeadLetterService(
      makeMockTransactions(records) as any,
      makeMockAdminService() as any,
      makeMockOrchestrator(false) as any,
    );
    const result = await service.redrive("tx2", "admin1");
    expect(result.status).toBe("requeued");
    expect(records[0].status).toBe("pending");
    expect(records[0].attempts).toBe(0);
  });

  it("markResolved logs and updates transaction", async () => {
    const records = [
      { id: "tx3", status: "dead", payoutId: "p3", attempts: 5, errorMessage: "err", updatedAt: new Date(), type: "payout", signedXdr: null },
    ];
    const adminSvc = makeMockAdminService();
    const service = new DeadLetterService(
      makeMockTransactions(records) as any,
      adminSvc as any,
      makeMockOrchestrator(false) as any,
    );
    await service.markResolved("tx3", "admin1", "Arena was cancelled, no payout needed");
    expect(records[0].status).toBe("failed");
    expect(adminSvc.logs[0].action).toBe("mark_resolved_dead_letter");
  });
});
