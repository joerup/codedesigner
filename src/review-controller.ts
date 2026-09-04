import type {
  Proposal,
  ProposalResult,
  ReviewDecision
} from "./contracts";
import { hashContent } from "./hash";
import type { ProposalStore } from "./proposal-store";

export interface DocumentStore {
  read(file: string): Promise<string>;
  write(file: string, content: string): Promise<void>;
}

export class ReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewConflictError";
  }
}

/** Applies one proposal verdict without allowing stale changes to overwrite notes. */
export class ReviewController {
  private reviewQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly proposals: ProposalStore,
    private readonly documents: DocumentStore
  ) {}

  resolve(proposalId: string, decision: ReviewDecision): Promise<ProposalResult> {
    return this.enqueue(() => this.resolveNow(proposalId, decision));
  }

  private async resolveNow(
    proposalId: string,
    decision: ReviewDecision
  ): Promise<ProposalResult> {
    const proposal = this.requireProposal(proposalId);
    if (proposal.decision !== undefined) throw new Error("Proposal is already resolved");
    if (decision === "rejected") return this.proposals.resolve(proposalId, decision);

    const updates: Array<{ file: string; before: string; after: string }> = [];
    for (const file of proposal.files) {
      const content = await this.documents.read(file.file);
      if ((await hashContent(content)) !== file.baseHash) {
        throw new ReviewConflictError(
          `Cannot accept this proposal: ${file.file} changed after the proposal was created`
        );
      }
      let updated = content;
      for (const change of [...file.changes].sort((left, right) => right.from - left.from)) {
        if (updated.slice(change.from, change.to) !== change.before) {
          throw new ReviewConflictError(
            `Cannot accept ${change.id}: the source text changed after the proposal was created`
          );
        }
        updated = updated.slice(0, change.from) + change.after + updated.slice(change.to);
      }
      updates.push({ file: file.file, before: content, after: updated });
    }

    this.requireProposal(proposalId);
    const written: typeof updates = [];
    try {
      for (const update of updates) {
        await this.documents.write(update.file, update.after);
        written.push(update);
      }
    } catch (error) {
      for (const update of written.reverse()) {
        await this.documents.write(update.file, update.before);
      }
      throw error;
    }
    this.requireProposal(proposalId);
    return this.proposals.resolve(proposalId, decision);
  }

  private requireProposal(proposalId: string): Proposal {
    const proposal = this.proposals.getActive();
    if (!proposal) throw new Error("No active proposal");
    if (proposal.proposalId !== proposalId) {
      throw new ReviewConflictError("The displayed proposal is no longer active");
    }
    return proposal;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.reviewQueue.then(operation);
    this.reviewQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
