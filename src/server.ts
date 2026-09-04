import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  proposalFileSchema,
  textRangeSchema,
  type ProposalRequest,
  type ProposalResult,
  type Selection
} from "./contracts";
import type { ProposalStore } from "./proposal-store";

const HOST = "127.0.0.1" as const;

const designFileSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\]+\.md$/, "file must be one Markdown filename, not a path")
  .refine((file) => file !== ".md" && file !== "..md", "file must name a repository");

const proposalFileInputSchema = proposalFileSchema.extend({
  file: designFileSchema
}).strict();

const proposalInputSchema = proposalFileInputSchema.superRefine((input, context) => {
  const ids = new Set<string>();
  const ordered = [...input.changes].sort((left, right) => left.from - right.from);
  for (const [changeIndex, change] of input.changes.entries()) {
    if (ids.has(change.id)) {
      context.addIssue({ code: "custom", path: ["changes", changeIndex, "id"], message: "change ids must be unique" });
    }
    ids.add(change.id);
    if (change.to < change.from || change.to - change.from !== change.before.length) {
      context.addIssue({ code: "custom", path: ["changes", changeIndex], message: "change offsets must exactly span before text" });
    }
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].to > ordered[index].from || ordered[index - 1].from === ordered[index].from) {
      context.addIssue({ code: "custom", path: ["changes"], message: "changes must not overlap or share a start offset" });
      break;
    }
  }
});

const proposalStatusInputSchema = z
  .object({ proposalId: z.string().uuid().optional() })
  .strict();

const changeRevisionSchema = z.object({
  id: z.string().min(1),
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  before: z.string().max(1_000_000).optional(),
  after: z.string().max(1_000_000).optional(),
  explanation: z.string().max(10_000).optional()
}).strict().superRefine((revision, context) => {
  const anchorFields = [revision.from, revision.to, revision.before];
  const anchorCount = anchorFields.filter((field) => field !== undefined).length;
  if (anchorCount !== 0 && anchorCount !== 3) {
    context.addIssue({
      code: "custom",
      message: "from, to, and before must be provided together"
    });
  }
  if (
    revision.after === undefined &&
    revision.explanation === undefined &&
    anchorCount === 0
  ) {
    context.addIssue({ code: "custom", message: "a revision must change at least one field" });
  }
  if (
    revision.from !== undefined &&
    revision.to !== undefined &&
    revision.before !== undefined &&
    (revision.to < revision.from || revision.to - revision.from !== revision.before.length)
  ) {
    context.addIssue({ code: "custom", message: "change offsets must exactly span before text" });
  }
});

const updateProposalInputSchema = z.object({
  proposalId: z.string().uuid(),
  changes: z.array(changeRevisionSchema).min(1).max(100)
}).strict().superRefine((input, context) => {
  const ids = new Set<string>();
  for (const [index, change] of input.changes.entries()) {
    if (ids.has(change.id)) {
      context.addIssue({
        code: "custom",
        path: ["changes", index, "id"],
        message: "change ids must be unique"
      });
    }
    ids.add(change.id);
  }
});

const selectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("document"),
      file: designFileSchema,
      text: z.string(),
      range: textRangeSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("proposal_explanation"),
      file: designFileSchema,
      proposalId: z.string().uuid(),
      changeId: z.string().min(1),
      text: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal("proposed_change"),
      file: designFileSchema,
      proposalId: z.string().uuid(),
      changeId: z.string().min(1),
      before: z.string(),
      after: z.string()
    })
    .strict()
]);

export interface CodeDesignServerOptions {
  store: ProposalStore;
  getSelection: () => Selection | Promise<Selection>;
  port?: number;
}

export interface ServerAddress {
  host: typeof HOST;
  port: number;
  url: string;
}

export class CodeDesignServer {
  private readonly port: number;
  private http: HttpServer | undefined;

  constructor(private readonly options: CodeDesignServerOptions) {
    this.port = options.port ?? 0;
  }

  async start(): Promise<ServerAddress> {
    if (this.http) throw new Error("Code Design server is already running");

    const http = createServer((request, response) => {
      if (!this.isLocalRequest(request)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      if (new URL(request.url ?? "/", `http://${HOST}`).pathname !== "/mcp") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const lengthHeader = request.headers["content-length"];
      const contentLength = Number(lengthHeader ?? 0);
      if (!Number.isFinite(contentLength) || contentLength > 2_000_000) {
        response.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
        response.end("Request too large");
        return;
      }

      const mcp = this.createProtocolServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        void transport.close().finally(() => mcp.close());
      };
      response.once("close", close);
      void mcp.connect(transport).then(() => transport.handleRequest(request, response)).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Internal MCP server error" }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.port, HOST, () => {
        http.off("error", reject);
        resolve();
      });
    });
    this.http = http;

    const address = http.address();
    if (!address || typeof address === "string") throw new Error("MCP server has no TCP address");
    return { host: HOST, port: address.port, url: `http://${HOST}:${address.port}` };
  }

  private isLocalRequest(request: IncomingMessage): boolean {
    const host = request.headers.host?.split(":", 1)[0];
    if (host !== HOST && host !== "localhost") return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      const originHost = new URL(origin).hostname;
      return originHost === HOST || originHost === "localhost";
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    const http = this.http;
    this.http = undefined;
    if (!http) return;
    await new Promise<void>((resolve, reject) => {
      http.close((error) => (error ? reject(error) : resolve()));
    });
  }

  /** Creates one stateless protocol server. Exposed for transport-independent tests. */
  createProtocolServer(): McpServer {
    const mcp = new McpServer({ name: "code-design", version: "0.1.0" });
    this.registerTools(mcp);
    return mcp;
  }

  private registerTools(mcp: McpServer): void {
    mcp.registerTool(
      "get_selection",
      {
        description:
          "Read the current Obsidian selection. Call this for every new request that refers to 'this', the selection, highlighted text, or the focused proposal. Never reuse a selection from an earlier turn.",
        annotations: { readOnlyHint: true, openWorldHint: false }
      },
      async () => {
        const selection = selectionSchema.parse(await this.options.getSelection());
        return jsonResult(selection);
      }
    );

    mcp.registerTool(
      "propose_changes",
      {
        description:
          "Propose one review transaction for one repository design document. Use one root-level .md file per repository. A proposal may contain several non-overlapping changes in that file. The user accepts or rejects the complete proposal as one unit. Describe only current or intended system state in document text. For a semantic change, explain the code-level necessity. Do not describe editing choices, readability, brevity, or formatting. For a meaning-preserving edit, use an empty explanation. Explanations never enter the document.",
        inputSchema: proposalInputSchema,
        annotations: { destructiveHint: false, openWorldHint: false }
      },
      async (input) => {
        const file = proposalInputSchema.parse(input);
        const request: ProposalRequest = { files: [file] };
        const proposal = this.options.store.create(request);
        return jsonResult(this.options.store.result(proposal));
      }
    );

    mcp.registerTool(
      "update_proposal",
      {
        description:
          "Revise one or more changes in the active pending proposal. Preserve each change id. Call get_selection first for every follow-up that refers to 'this', selected proposal text, or a selected explanation. Omit fields that must remain unchanged. To expand or move a suggestion, provide from, to, and before together. Revised anchors must exactly span before text and must not overlap another change. This tool cannot revise a resolved proposal.",
        inputSchema: updateProposalInputSchema,
        annotations: { destructiveHint: false, openWorldHint: false }
      },
      async (input) => {
        const update = updateProposalInputSchema.parse(input);
        return jsonResult(this.options.store.revise(
          update.proposalId,
          update.changes
        ));
      }
    );

    mcp.registerTool(
      "proposal_status",
      {
        description:
          "Read the current proposal review status after propose_changes. Poll when the user may still be reviewing. The result reports one proposal-level decision.",
        inputSchema: proposalStatusInputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false }
      },
      async (input) => {
        const { proposalId } = proposalStatusInputSchema.parse(input);
        const active = this.options.store.getActive();
        if (!active) return jsonResult({ status: "none" });
        if (proposalId && active.proposalId !== proposalId) {
          return errorResult(`Proposal ${proposalId} is not active`);
        }
        return jsonResult(this.options.store.result(active));
      }
    );
  }
}

function jsonResult(value: Selection | ProposalResult | { status: "none" }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }]
  };
}
