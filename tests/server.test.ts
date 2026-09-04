import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { ProposalStore } from "../src/proposal-store";
import { CodeDesignServer } from "../src/server";

describe("CodeDesignServer", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("binds to loopback and returns the live Obsidian selection", async () => {
    const { client } = await startClient(new ProposalStore(), () => ({
      kind: "document",
      file: "era-mneme.md",
      text: "the selected boundary",
      range: { from: { line: 4, ch: 0 }, to: { line: 4, ch: 21 } }
    }));

    const result = await client.callTool({ name: "get_selection", arguments: {} });
    expect(readJson(result)).toEqual({
      kind: "document",
      file: "era-mneme.md",
      text: "the selected boundary",
      range: { from: { line: 4, ch: 0 }, to: { line: 4, ch: 21 } }
    });
  });

  it("creates a proposal and reports its final decision", async () => {
    const store = new ProposalStore();
    const { client } = await startClient(store, () => ({ kind: "none" }));
    const proposal = readJson(
      await client.callTool({
        name: "propose_changes",
        arguments: {
          file: "era-mneme.md",
          baseHash: "0".repeat(64),
          changes: [
            {
              id: "search-backend",
              from: 10,
              to: 18,
              before: "Postgres",
              after: "Milvus",
              explanation: "The implementation now delegates vector search to Milvus."
            }
          ]
        }
      })
    ) as { proposalId: string; status: string };

    expect(proposal).toMatchObject({ status: "pending" });
    store.resolve(proposal.proposalId, "accepted");

    const status = await client.callTool({
      name: "proposal_status",
      arguments: { proposalId: proposal.proposalId }
    });
    expect(readJson(status)).toEqual({
      proposalId: proposal.proposalId,
      status: "resolved",
      decision: "accepted"
    });
  });

  it("accepts an empty explanation for a meaning-preserving edit", async () => {
    const store = new ProposalStore();
    const { client } = await startClient(store, () => ({ kind: "none" }));
    const result = await client.callTool({
      name: "propose_changes",
      arguments: {
        file: "era-mneme.md",
        baseHash: "0".repeat(64),
        changes: [
          { id: "clarity", from: 0, to: 4, before: "text", after: "copy", explanation: "" }
        ]
      }
    });

    expect(result.isError).not.toBe(true);
    expect(store.getActive()?.files[0].changes[0].explanation).toBe("");
  });

  it("updates an unresolved suggestion in place", async () => {
    const store = new ProposalStore();
    const { client } = await startClient(store, () => ({ kind: "none" }));
    const proposal = readJson(await client.callTool({
      name: "propose_changes",
      arguments: {
        file: "era-mneme.md",
        baseHash: "0".repeat(64),
        changes: [{ id: "backend", from: 0, to: 8, before: "Postgres", after: "Milvus", explanation: "Initial reason." }]
      }
    })) as { proposalId: string };

    const result = await client.callTool({
      name: "update_proposal",
      arguments: {
        proposalId: proposal.proposalId,
        changes: [{ id: "backend", after: "Qdrant", explanation: "The code now uses Qdrant." }]
      }
    });

    expect(result.isError).not.toBe(true);
    expect(store.getActive()?.files[0].changes[0]).toMatchObject({
      before: "Postgres",
      after: "Qdrant",
      explanation: "The code now uses Qdrant."
    });
  });

  it("expands the source anchor of an unresolved suggestion", async () => {
    const store = new ProposalStore();
    const { client } = await startClient(store, () => ({ kind: "none" }));
    const proposal = readJson(await client.callTool({
      name: "propose_changes",
      arguments: {
        file: "era-mneme.md",
        baseHash: "0".repeat(64),
        changes: [{ id: "response", from: 0, to: 5, before: "first", after: "updated", explanation: "" }]
      }
    })) as { proposalId: string };

    const result = await client.callTool({
      name: "update_proposal",
      arguments: {
        proposalId: proposal.proposalId,
        changes: [{ id: "response", from: 0, to: 12, before: "first\nsecond", after: "updated" }]
      }
    });

    expect(result.isError).not.toBe(true);
    expect(store.getActive()?.files[0].changes[0]).toMatchObject({
      from: 0,
      to: 12,
      before: "first\nsecond",
      after: "updated"
    });
  });

  it("rejects a partial source-anchor revision", async () => {
    const store = new ProposalStore();
    const { client } = await startClient(store, () => ({ kind: "none" }));
    const proposal = readJson(await client.callTool({
      name: "propose_changes",
      arguments: {
        file: "era-mneme.md",
        baseHash: "0".repeat(64),
        changes: [{ id: "response", from: 0, to: 5, before: "first", after: "updated", explanation: "" }]
      }
    })) as { proposalId: string };

    const result = await client.callTool({
      name: "update_proposal",
      arguments: {
        proposalId: proposal.proposalId,
        changes: [{ id: "response", to: 12 }]
      }
    });

    expect(result.isError).toBe(true);
  });

  it("rejects the former multi-file proposal shape", async () => {
    const { client } = await startClient(new ProposalStore(), () => ({ kind: "none" }));

    const result = await client.callTool({
      name: "propose_changes",
      arguments: {
        files: [{
          file: "one.md",
          baseHash: "0".repeat(64),
          changes: [{ id: "one", from: 0, to: 0, before: "", after: "one", explanation: "" }]
        }]
      }
    });

    expect(result.isError).toBe(true);
  });

  it("rejects duplicate change ids", async () => {
    const { client } = await startClient(new ProposalStore(), () => ({ kind: "none" }));
    const result = await client.callTool({
      name: "propose_changes",
      arguments: {
        file: "one.md",
        baseHash: "0".repeat(64),
        changes: ["one", "two"].map((after) => ({
          id: "duplicate", from: after === "one" ? 0 : 1, to: after === "one" ? 0 : 1,
          before: "", after, explanation: ""
        }))
      }
    });

    expect(result.isError).toBe(true);
  });

  it("rejects paths and unknown input fields", async () => {
    const { client } = await startClient(new ProposalStore(), () => ({ kind: "none" }));
    const result = await client.callTool({
      name: "propose_changes",
      arguments: {
        file: "../outside.md",
        baseHash: "0".repeat(64),
        changes: [
          { id: "one", from: 0, to: 0, before: "", after: "text", explanation: "Required." }
        ],
        unexpected: true
      }
    });

    expect(result.isError).toBe(true);
  });

  async function startClient(store: ProposalStore, getSelection: () => ReturnTypeSelection) {
    const httpServer = new CodeDesignServer({ store, getSelection, port: 0 });
    const protocolServer = httpServer.createProtocolServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "code-design-test", version: "0.1.0" });
    await protocolServer.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await protocolServer.close();
    });
    return { client };
  }
});

type ReturnTypeSelection =
  | { kind: "none" }
  | {
      kind: "document";
      file: string;
      text: string;
      range: { from: { line: number; ch: number }; to: { line: number; ch: number } };
    };

function readJson(result: unknown): unknown {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("Tool result has no content");
  }
  const content = result.content;
  if (!Array.isArray(content)) throw new Error("Tool result has no content");
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Tool result has no text content");
  }
  return JSON.parse(first.text) as unknown;
}
