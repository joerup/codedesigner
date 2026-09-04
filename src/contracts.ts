import { z } from "zod";

export const textPositionSchema = z.object({
  line: z.number().int().nonnegative(),
  ch: z.number().int().nonnegative()
});

export const textRangeSchema = z.object({
  from: textPositionSchema,
  to: textPositionSchema
});

export const proposedChangeSchema = z.object({
  id: z.string().min(1),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  before: z.string().max(1_000_000),
  after: z.string().max(1_000_000),
  explanation: z.string().max(10_000)
});

export const proposalFileSchema = z.object({
  file: z.string().min(1).refine((file) => file.endsWith(".md"), "file must end in .md"),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/, "baseHash must be a lowercase SHA-256 digest"),
  changes: z.array(proposedChangeSchema).min(1).max(100)
});

export const proposalRequestSchema = z.object({
  files: z.array(proposalFileSchema).length(1)
});

export type TextPosition = z.infer<typeof textPositionSchema>;
export type TextRange = z.infer<typeof textRangeSchema>;
export type ProposedChange = z.infer<typeof proposedChangeSchema>;
export type ProposalFile = z.infer<typeof proposalFileSchema>;
export type ProposalRequest = z.infer<typeof proposalRequestSchema>;

export interface ChangeRevision {
  id: string;
  from?: number;
  to?: number;
  before?: string;
  after?: string;
  explanation?: string;
}

export type ReviewDecision = "accepted" | "rejected";

export interface Proposal extends ProposalRequest {
  proposalId: string;
  decision?: ReviewDecision;
  createdAt: string;
}

export type Selection =
  | { kind: "none" }
  | { kind: "document"; file: string; text: string; range: TextRange }
  | {
      kind: "proposal_explanation";
      file: string;
      proposalId: string;
      changeId: string;
      text: string;
    }
  | {
      kind: "proposed_change";
      file: string;
      proposalId: string;
      changeId: string;
      before: string;
      after: string;
    };

export interface ProposalResult {
  proposalId: string;
  status: "pending" | "resolved";
  decision?: ReviewDecision;
}
