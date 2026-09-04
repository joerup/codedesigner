import { describe, expect, it } from "vitest";

import { hashContent } from "../src/hash";
import { ProposalStore } from "../src/proposal-store";
import { type DocumentStore, ReviewConflictError, ReviewController } from "../src/review-controller";

class MemoryDocuments implements DocumentStore {
  constructor(public content: string) {}
  async read(): Promise<string> { return this.content; }
  async write(_file: string, content: string): Promise<void> { this.content = content; }
}

async function setup(content = "alpha beta gamma") {
  const store = new ProposalStore();
  const documents = new MemoryDocuments(content);
  const proposal = store.create({
    files: [{
      file: "era-mneme.md",
      baseHash: await hashContent(content),
      changes: [
        { id: "alpha", from: 0, to: 5, before: "alpha", after: "ALPHA", explanation: "" },
        { id: "gamma", from: 11, to: 16, before: "gamma", after: "G", explanation: "" }
      ]
    }]
  });
  return {
    store,
    documents,
    proposalId: proposal.proposalId,
    controller: new ReviewController(store, documents)
  };
}

describe("ReviewController", () => {
  it("accepts every change in the proposal as one unit", async () => {
    const { controller, documents, proposalId } = await setup();

    const result = await controller.resolve(proposalId, "accepted");

    expect(documents.content).toBe("ALPHA beta G");
    expect(result).toEqual({ proposalId, status: "resolved", decision: "accepted" });
  });

  it("rejects the proposal without writing the document", async () => {
    const { controller, documents, proposalId } = await setup();

    const result = await controller.resolve(proposalId, "rejected");

    expect(documents.content).toBe("alpha beta gamma");
    expect(result.decision).toBe("rejected");
  });

  it("rejects an accepted proposal when the document changed externally", async () => {
    const { controller, documents, proposalId } = await setup();
    documents.content = "external edit";

    await expect(controller.resolve(proposalId, "accepted"))
      .rejects.toBeInstanceOf(ReviewConflictError);
    expect(documents.content).toBe("external edit");
  });

  it("serializes concurrent proposal verdicts", async () => {
    const { controller, proposalId } = await setup();

    const results = await Promise.allSettled([
      controller.resolve(proposalId, "accepted"),
      controller.resolve(proposalId, "rejected")
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("accepts an expanded anchor after the agent revises the proposal", async () => {
    const content = "first\nsecond\nthird";
    const store = new ProposalStore();
    const documents = new MemoryDocuments(content);
    const proposal = store.create({
      files: [{
        file: "era-mneme.md",
        baseHash: await hashContent(content),
        changes: [{ id: "response", from: 0, to: 5, before: "first", after: "updated", explanation: "" }]
      }]
    });
    store.revise(proposal.proposalId, [{
      id: "response",
      from: 0,
      to: 12,
      before: "first\nsecond",
      after: "updated"
    }]);

    await new ReviewController(store, documents).resolve(proposal.proposalId, "accepted");

    expect(documents.content).toBe("updated\nthird");
  });
});
