import {
  CreatePulseDraftRequestSchema,
  DeletePulseDraftRequestSchema,
  ExecutePulseDeleteRequestSchema,
  PreparePulseDeleteRequestSchema,
  PreparePulsePublishRequestSchema,
  PublishPulseDraftRequestSchema,
  PulseAuthorProposalRequestSchema,
  PulseMetricPreviewRequestSchema,
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
import { requirePulseOwner } from "../application/context.js";
import { PulseApplicationError } from "../application/errors.js";
import { runMutationJob, type MutationJobResponse } from "./mutation-jobs.js";
import {
  PulseProposalService,
  type ProposalDependencies,
} from "../application/proposals.js";
import {
  PulsePublishService,
  type PublishDependencies,
  type PulsePublicationCommand,
} from "../application/publish.js";
import { previewPulseMetric } from "../application/metric-preview.js";
import { PulseRepository } from "../persistence/repository.js";

export interface PulseWorkflowDependencies {
  catalog?: PublishDependencies["catalog"];
  propose?: ProposalDependencies["propose"];
  publish?: Partial<PublishDependencies>;
  deletion?: DeleteDependencies;
}
/** The response an application failure gives, so a job can answer exactly as its route would. */
function applicationErrorResponse(error: unknown): MutationJobResponse | undefined {
  if (!(error instanceof PulseApplicationError)) return undefined;
  return {
    status: error.statusCode,
    body: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
  };
}
function parse<Schema extends z.ZodTypeAny>(schema: Schema, input: unknown): z.output<Schema> {
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
  server: FastifyInstance,
  dependencies: PulseWorkflowDependencies = {},
): void {
  server.register(async (app) => {
    // Workspace field IDs can be "__proto__". Their schemas validate own entries.
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string" },
      app.getDefaultJsonParser("ignore", "error"));
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
        const response = applicationErrorResponse(error);
        if (response) return reply.code(response.status).send(response.body);
        throw error;
      }
    };
    /**
     * Answers a publication command: with its receipt when one already
     * answers it, otherwise by running its Tableau writes as a mutation job
     * whose final response is the receipt.
     */
    const runPublication = (
      reply: FastifyReply,
      kind: "publish" | "undo" | "group_delete",
      command: PulsePublicationCommand,
    ): unknown => "receipt" in command
      ? command.receipt
      : runMutationJob(reply, kind, command.session, async () => ({ status: 200, body: await command.run() }), applicationErrorResponse);
    app.post("/api/pulse/metrics/:metricId/preview", (req, reply) =>
      respond(reply, () => previewPulseMetric(
        parse(z.string().min(1).max(255), (req.params as { metricId: string }).metricId),
        parse(PulseMetricPreviewRequestSchema, req.body),
      )),
    );
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
        runPublication(reply, "publish", publish.publish(
          id(req.params),
          parse(PublishPulseDraftRequestSchema, req.body),
        )),
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
      respond(reply, () => runPublication(reply, "undo", publish.undo(id(req.params)))),
    );
    app.post("/api/pulse/receipts/:id/delete-group", (req, reply) =>
      respond(reply, () =>
        runPublication(reply, "group_delete", publish.deleteCreatedGroup(
          id(req.params),
          parse(
            z.object({ groupId: z.string().trim().min(1).max(200) }).strict(),
            req.body,
          ).groupId,
        )),
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
      respond(reply, () => {
        const request = parse(ExecutePulseDeleteRequestSchema, req.body);
        return runMutationJob(reply, "delete", requirePulseOwner(request.context), async () => {
          const result = await deletion.execute(request);
          return { status: result.throttle && result.outcomes.every(outcome => outcome.sent === false) ? 429 : 200, body: result };
        }, applicationErrorResponse);
      }),
    );
  });
}
