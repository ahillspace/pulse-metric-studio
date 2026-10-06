import {
  CreatePulseDraftRequestSchema,
  DeletePulseDraftRequestSchema,
  ExecutePulseDeleteRequestSchema,
  PreparePulseDeleteRequestSchema,
  PreparePulsePublishRequestSchema,
  PublishPulseDraftRequestSchema,
  PulseAuthorProposalRequestSchema,
  PulseListQuerySchema,
  PulseDraftListQuerySchema,
  SavePulseDraftRequestSchema,
} from "@pulse-metric-studio/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  PulseDeletionService,
  type DeleteDependencies,
} from "../application/deletion.js";
import { PulseApplicationError } from "../application/errors.js";
import {
  PulseProposalService,
  type ProposalDependencies,
} from "../application/proposals.js";
import {
  PulsePublishService,
  type PublishDependencies,
} from "../application/publish.js";
import { PulseRepository } from "../persistence/repository.js";

export interface PulseWorkflowDependencies {
  catalog?: PublishDependencies["catalog"];
  propose?: ProposalDependencies["propose"];
  publish?: Partial<PublishDependencies>;
  deletion?: DeleteDependencies;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new PulseApplicationError(
      "invalid_request",
      result.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  return result.data;
}
export function registerPulseWorkflowRoutes(
  app: FastifyInstance,
  dependencies: PulseWorkflowDependencies = {},
): void {
  const repository = new PulseRepository();
  const publish = new PulsePublishService(repository, {
    ...dependencies.publish,
    ...(dependencies.catalog ? { catalog: dependencies.catalog } : {}),
  });
  const proposals = new PulseProposalService(repository, {
    ...(dependencies.catalog ? { catalog: dependencies.catalog } : {}),
    ...(dependencies.propose ? { propose: dependencies.propose } : {}),
  });
  const deletion = new PulseDeletionService(dependencies.deletion);
  const id = (params: unknown) => (params as { id: string }).id;
  const respond = async (
    reply: FastifyReply,
    work: () => unknown,
  ): Promise<unknown> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PulseApplicationError)
        return reply.code(error.statusCode).send({
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      throw error;
    }
  };
  app.get("/api/pulse/drafts", (req, reply) =>
    respond(reply, () =>
      repository.listDrafts(parse(PulseDraftListQuerySchema, req.query)),
    ),
  );
  app.post("/api/pulse/drafts", (req, reply) =>
    respond(reply, () =>
      repository.createDraft(parse(CreatePulseDraftRequestSchema, req.body)),
    ),
  );
  app.get("/api/pulse/drafts/:id", (req, reply) =>
    respond(reply, () => repository.getDraft(id(req.params))),
  );
  app.put("/api/pulse/drafts/:id", (req, reply) =>
    respond(reply, () =>
      repository.saveDraft(
        id(req.params),
        parse(SavePulseDraftRequestSchema, req.body),
      ),
    ),
  );
  app.delete("/api/pulse/drafts/:id", (req, reply) =>
    respond(reply, () => {
      repository.deleteDraft(
        id(req.params),
        parse(DeletePulseDraftRequestSchema, req.body).expectedRevision,
      );
      return { ok: true };
    }),
  );
  app.post("/api/pulse/drafts/:id/publish-preview", (req, reply) =>
    respond(reply, () =>
      publish.preview(
        id(req.params),
        parse(PreparePulsePublishRequestSchema, req.body).expectedRevision,
      ),
    ),
  );
  app.post("/api/pulse/drafts/:id/publish", (req, reply) =>
    respond(reply, () =>
      publish.publish(
        id(req.params),
        parse(PublishPulseDraftRequestSchema, req.body),
      ),
    ),
  );
  app.post("/api/pulse/drafts/:id/proposals", (req, reply) =>
    respond(reply, () => {
      const body = parse(PulseAuthorProposalRequestSchema, req.body);
      return proposals.propose(
        id(req.params),
        body.baseRevision,
        body.message,
        body.document,
      );
    }),
  );
  app.get("/api/pulse/receipts", (req, reply) =>
    respond(reply, () =>
      repository.listReceipts(parse(PulseListQuerySchema, req.query)),
    ),
  );
  app.get("/api/pulse/receipts/:id", (req, reply) =>
    respond(reply, () => repository.getReceipt(id(req.params))),
  );
  app.post("/api/pulse/receipts/:id/undo", (req, reply) =>
    respond(reply, () => publish.undo(id(req.params))),
  );
  app.post("/api/pulse/receipts/:id/delete-group", (req, reply) =>
    respond(reply, () =>
      publish.deleteCreatedGroup(
        id(req.params),
        parse(
          z.object({ groupId: z.string().trim().min(1).max(200) }).strict(),
          req.body,
        ).groupId,
      ),
    ),
  );
  app.delete("/api/pulse/receipts/:id", (req, reply) =>
    respond(reply, () => {
      repository.clearReceipt(id(req.params));
      return { ok: true };
    }),
  );
  app.get("/api/pulse/archives", (_req, reply) =>
    respond(reply, () => repository.archives()),
  );
  app.post("/api/pulse/registry/delete-preview", (req, reply) =>
    respond(reply, () =>
      deletion.preview(parse(PreparePulseDeleteRequestSchema, req.body)),
    ),
  );
  app.post("/api/pulse/registry/delete", (req, reply) =>
    respond(reply, () =>
      deletion.execute(parse(ExecutePulseDeleteRequestSchema, req.body)),
    ),
  );
}
