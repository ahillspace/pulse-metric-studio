import {
  getFieldCatalog,
  getLoadedFieldCatalog,
  getLlmRegistry,
  type TableauSession,
} from "@pulse-metric-studio/core";
import {
  applyPulseProposal,
  describePulseDocumentChanges,
  type DatasourceCatalog,
  type Op,
  type PulseAuthorProposal,
  type PulseWorkspaceDocumentV1,
} from "@pulse-metric-studio/shared";
import { authorOps } from "../llm-authoring.js";
import { PulseRepository } from "../persistence/repository.js";
import { requirePulseOwner } from "./context.js";

export interface ProposalInput {
  catalog: DatasourceCatalog;
  document: PulseWorkspaceDocumentV1;
  message: string;
}
export interface ProposalDependencies {
  catalog(
    session: TableauSession,
    datasourceLuid: string,
  ): Promise<DatasourceCatalog>;
  propose(
    input: ProposalInput,
  ): Promise<{ ops: Op[]; assistantMessage: string; digestAudience?: string }>;
}
async function propose(input: ProposalInput) {
  return authorOps(await getLlmRegistry().pick(), {
    catalog: input.catalog,
    chat: input.document.chat,
    userMessage: input.message,
    selection: {
      metrics: input.document.metrics,
      slicers: input.document.slicers,
      digestAudience: input.document.digestAudience,
      digestAudienceLocked: input.document.digestAudienceLocked,
    },
  });
}
export class PulseProposalService {
  private readonly deps: ProposalDependencies;
  constructor(
    private readonly repository = new PulseRepository(),
    dependencies: Partial<ProposalDependencies> = {},
  ) {
    this.deps = {
      catalog: async (session, luid) =>
        getLoadedFieldCatalog(session, luid) ?? getFieldCatalog(session, luid),
      propose,
      ...dependencies,
    };
  }
  async propose(
    draftId: string,
    baseRevision: number,
    message: string,
    document?: PulseWorkspaceDocumentV1,
  ): Promise<PulseAuthorProposal> {
    const draft = document
      ? this.repository.getDraft(draftId)
      : this.repository.assertRevision(draftId, baseRevision);
    const baseDocument = document ?? draft.document;
    const session = requirePulseOwner(draft.context);
    const catalog = await this.deps.catalog(
      session,
      draft.context.datasourceLuid,
    );
    requirePulseOwner(draft.context, session);
    const response = await this.deps.propose({
      catalog,
      document: baseDocument,
      message,
    });
    this.repository.getDraft(draftId);
    requirePulseOwner(draft.context, session);
    const candidateDocument = applyPulseProposal(
      baseDocument,
      response.ops,
      catalog,
    );
    if (response.digestAudience && !baseDocument.digestAudienceLocked)
      candidateDocument.digestAudience = response.digestAudience;
    const changes = describePulseDocumentChanges(baseDocument, candidateDocument, catalog);
    candidateDocument.chat.push(
      { role: "user", content: message, ts: Date.now() },
      {
        role: "assistant",
        content: response.assistantMessage,
        proposalContext: JSON.stringify(response.ops),
        ts: Date.now(),
      },
    );
    return {
      baseRevision,
      candidateDocument,
      changes,
      assistantMessage: response.assistantMessage,
    };
  }
}
