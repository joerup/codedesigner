import { describe, expect, it, vi } from "vitest";

import { ProposalStore } from "../src/proposal-store";

const request = {
  files: [{
    file: "era-mneme.md",
    baseHash: "abc123",
    changes: [
      {
        id: "search-backend",
        from: 0,
        to: 8,
        before: "Postgres",
        after: "Milvus",
        explanation: "The implementation uses Milvus."
      }
    ]
  }]
};

describe("ProposalStore", () => {
  it("creates and resolves an in-memory proposal", () => {
    const store = new ProposalStore();
    const proposal = store.create(request);

    expect(store.result(proposal).status).toBe("pending");
    expect(store.resolve(proposal.proposalId, "accepted")).toEqual({
      proposalId: proposal.proposalId,
      status: "resolved",
      decision: "accepted"
    });
  });

  it("publishes changes and clears proposal state", () => {
    const store = new ProposalStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.create(request);
    store.clear();
    unsubscribe();

    expect(listener).toHaveBeenNthCalledWith(1, undefined);
    expect(listener).toHaveBeenNthCalledWith(3, undefined);
  });

  it("republishes active state when the editor context changes", () => {
    const store = new ProposalStore();
    const listener = vi.fn();
    store.create(request);
    store.subscribe(listener);

    store.refresh();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(store.getActive());
  });

  it("rejects a verdict for a different proposal", () => {
    const store = new ProposalStore();
    store.create(request);

    expect(() => store.resolve("00000000-0000-4000-8000-000000000000", "accepted")).toThrow("is not active");
  });

  it("focuses a change without resolving it", () => {
    const store = new ProposalStore();
    const listener = vi.fn();
    const proposal = store.create(request);
    store.subscribe(listener);

    store.focus("search-backend");

    expect(store.getFocusedChangeId()).toBe("search-backend");
    expect(store.result(proposal).status).toBe("pending");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("revises pending content without changing the proposal", () => {
    const store = new ProposalStore();
    const proposal = store.create(request);

    const result = store.revise(proposal.proposalId, [{
      id: "search-backend",
      after: "Qdrant",
      explanation: "The implementation uses Qdrant."
    }]);

    expect(result).toMatchObject({ proposalId: proposal.proposalId, status: "pending" });
    expect(store.getActive()?.files[0].changes[0]).toMatchObject({
      before: "Postgres",
      after: "Qdrant",
      explanation: "The implementation uses Qdrant."
    });
  });

  it("rejects revisions to a resolved proposal", () => {
    const store = new ProposalStore();
    const proposal = store.create(request);
    store.resolve(proposal.proposalId, "rejected");

    expect(() => store.revise(proposal.proposalId, [
      { id: "search-backend", after: "Qdrant" }
    ])).toThrow("Proposal is already resolved");
  });

  it("rejects a proposal that targets more than one file", () => {
    const store = new ProposalStore();

    expect(() => store.create({ files: [request.files[0], request.files[0]] }))
      .toThrow("exactly one file");
  });
});
