import { randomUUID } from "node:crypto";

import type {
  ChangeRevision,
  Proposal,
  ProposalRequest,
  ProposalResult,
  ReviewDecision
} from "./contracts";

type Listener = (proposal: Proposal | undefined) => void;

export class ProposalStore {
  private active: Proposal | undefined;
  private focusedChangeId: string | undefined;
  private readonly listeners = new Set<Listener>();

  create(request: ProposalRequest): Proposal {
    if (request.files.length !== 1) throw new Error("A proposal must target exactly one file");
    if (this.active && this.result(this.active).status === "pending") {
      throw new Error(`Proposal ${this.active.proposalId} still requires review`);
    }
    this.active = {
      ...request,
      proposalId: randomUUID(),
      createdAt: new Date().toISOString()
    };
    this.focusedChangeId = request.files[0]?.changes[0]?.id;
    this.publish();
    return this.active;
  }

  getActive(): Proposal | undefined {
    return this.active;
  }

  getFocusedChangeId(): string | undefined {
    return this.focusedChangeId;
  }

  focus(changeId: string): void {
    const proposal = this.requireActive();
    if (!proposal.files.some((file) => file.changes.some((change) => change.id === changeId))) {
      throw new Error(`Unknown change: ${changeId}`);
    }
    this.focusedChangeId = changeId;
    this.publish();
  }

  resolve(proposalId: string, decision: ReviewDecision): ProposalResult {
    const proposal = this.requireActive();
    if (proposal.proposalId !== proposalId) throw new Error(`Proposal ${proposalId} is not active`);
    if (proposal.decision !== undefined) throw new Error("Proposal is already resolved");
    this.active = {
      ...proposal,
      decision
    };
    this.publish();
    return this.result(this.active);
  }

  revise(proposalId: string, revisions: readonly ChangeRevision[]): ProposalResult {
    const proposal = this.requireActive();
    if (proposal.proposalId !== proposalId) {
      throw new Error(`Proposal ${proposalId} is not active`);
    }

    const changes = new Map(
      proposal.files.flatMap((file) => file.changes.map((change) => [change.id, change] as const))
    );
    for (const revision of revisions) {
      if (!changes.has(revision.id)) throw new Error(`Unknown change: ${revision.id}`);
    }
    if (proposal.decision !== undefined) throw new Error("Proposal is already resolved");

    const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]));
    const files = proposal.files.map((file) => ({
      ...file,
      changes: file.changes.map((change) => {
        const revision = revisionsById.get(change.id);
        return revision ? { ...change, ...revision } : change;
      })
    }));
    for (const file of files) {
      const ordered = [...file.changes].sort((left, right) => left.from - right.from);
      for (const change of ordered) {
        if (change.to < change.from || change.to - change.from !== change.before.length) {
          throw new Error(`Change ${change.id} offsets must exactly span before text`);
        }
      }
      for (let index = 1; index < ordered.length; index += 1) {
        if (
          ordered[index - 1].to > ordered[index].from ||
          ordered[index - 1].from === ordered[index].from
        ) {
          throw new Error(`Revised change ${ordered[index].id} overlaps another change`);
        }
      }
    }

    this.active = {
      ...proposal,
      files
    };
    this.publish();
    return this.result(this.active);
  }

  clear(): void {
    this.active = undefined;
    this.focusedChangeId = undefined;
    this.publish();
  }

  refresh(): void {
    this.publish();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.active);
    return () => this.listeners.delete(listener);
  }

  result(proposal = this.requireActive()): ProposalResult {
    return {
      proposalId: proposal.proposalId,
      status: proposal.decision === undefined ? "pending" : "resolved",
      ...(proposal.decision === undefined ? {} : { decision: proposal.decision })
    };
  }

  private requireActive(): Proposal {
    if (!this.active) throw new Error("No active proposal");
    return this.active;
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.active);
  }
}
