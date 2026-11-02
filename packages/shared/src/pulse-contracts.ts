import { z } from 'zod';

// App resource guards, not undocumented Tableau field limits.
export const PULSE_TEXT_LIMITS = { name: 32768, description: 262144, audience: 32768, conversation: 1048576 } as const;

const id = z.string().trim().min(1).max(1024);
export const PulseOwnerSchema = z.object({
  connectionId: id,
  serverUrl: z.string().url(),
  siteId: id,
});
export const PulseDraftContextSchema = PulseOwnerSchema.extend({
  datasourceLuid: id,
});
export type PulseOwner = z.infer<typeof PulseOwnerSchema>;
export type PulseDraftContext = z.infer<typeof PulseDraftContextSchema>;
export const PulseMetricDraftSchema = z.object({
  active: z.boolean(),
  fieldId: id,
  fieldLabel: z.string(),
  aggregation: z.enum([
    'SUM',
    'AVERAGE',
    'AVG',
    'MIN',
    'MAX',
    'COUNT_DISTINCT',
    'USER',
  ]),
  cumulative: z.boolean(),
  format: z.enum(['NUMBER', 'CURRENCY', 'PERCENT']),
  sentiment: z.enum(['UP', 'DOWN', 'NONE']),
  name: z.string().max(PULSE_TEXT_LIMITS.name),
  description: z.string().max(PULSE_TEXT_LIMITS.description),
  timeDimensionFieldId: z.string().nullable(),
  minGranularity: z.enum(['', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']),
  temporality: z.enum(['OVER_TIME', 'LATEST']),
  locks: z.array(z.string()),
});
export const PulseSlicerDraftSchema = z.object({
  active: z.boolean(),
  fieldId: id,
  fieldLabel: z.string(),
});
export const PulseWorkspaceDocumentV1Schema = z.object({
  // Validate entries without z.record dropping a legitimate "__proto__" field ID.
  metrics: z.preprocess(
    (value) => value && Object.prototype.toString.call(value) === '[object Object]' ? new Map(Object.entries(value)) : null,
    z.map(z.string(), PulseMetricDraftSchema).transform((entries) => Object.fromEntries(entries)),
  ),
  slicers: z.preprocess(
    (value) => value && Object.prototype.toString.call(value) === '[object Object]' ? new Map(Object.entries(value)) : null,
    z.map(z.string(), PulseSlicerDraftSchema).transform((entries) => Object.fromEntries(entries)),
  ),
  digestAudience: z.string().max(PULSE_TEXT_LIMITS.audience),
  digestAudienceLocked: z.boolean(),
  groupFollow: z.boolean(),
  chat: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().max(PULSE_TEXT_LIMITS.conversation),
      proposalContext: z.string().max(PULSE_TEXT_LIMITS.conversation).optional(),
      ts: z.number().int().nonnegative(),
    }),
  ),
});
export type PulseMetricDraft = z.infer<typeof PulseMetricDraftSchema>;
export type PulseWorkspaceDocumentV1 = z.infer<
  typeof PulseWorkspaceDocumentV1Schema
>;
export const PulseDraftRecordSchema = z.object({
  id,
  context: PulseDraftContextSchema,
  datasourceName: z.string(),
  schemaVersion: z.literal(1),
  revision: z.number().int().positive(),
  document: PulseWorkspaceDocumentV1Schema,
  updatedAt: z.number().int(),
});
export type PulseDraftRecord = z.infer<typeof PulseDraftRecordSchema>;
export const CreatePulseDraftRequestSchema = z.object({
  context: PulseDraftContextSchema,
  datasourceName: z.string(),
  document: PulseWorkspaceDocumentV1Schema.optional(),
});
export const SavePulseDraftRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  document: PulseWorkspaceDocumentV1Schema,
});
export const DeletePulseDraftRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export const PreparePulsePublishRequestSchema = DeletePulseDraftRequestSchema;
export const PublishPulseDraftRequestSchema =
  PreparePulsePublishRequestSchema.extend({
    commandId: z.string().uuid(),
    previewFingerprint: id,
  });
export type CreatePulseDraftRequest = z.infer<
  typeof CreatePulseDraftRequestSchema
>;
export type SavePulseDraftRequest = z.infer<typeof SavePulseDraftRequestSchema>;
export type PublishPulseDraftRequest = z.infer<
  typeof PublishPulseDraftRequestSchema
>;
export const PulseValidationIssueSchema = z.object({
  field: z.string(),
  message: z.string(),
});
export const PulseDefinitionSummarySchema = z.object({
  version: z.literal(1),
  fieldId: z.string(),
  fieldLabel: z.string(),
  aggregation: z.string(),
  timeDimensionFieldId: z.string().nullable(),
  timeDimensionLabel: z.string(),
  temporality: z.string(),
  cumulative: z.boolean(),
  slicers: z.array(z.object({ fieldId: z.string(), fieldLabel: z.string() })),
});
export type PulseDefinitionSummary = z.infer<
  typeof PulseDefinitionSummarySchema
>;
export const PulsePublishPlanSchema = z.object({
  draftId: id,
  revision: z.number().int().positive(),
  context: PulseDraftContextSchema,
  datasourceName: z.string(),
  previewFingerprint: z.string(),
  metrics: z.array(
    PulseDefinitionSummarySchema.extend({
      name: z.string(),
      description: z.string(),
    }),
  ),
  digestAudience: z.string(),
  groupFollow: z.boolean(),
  issues: z.array(PulseValidationIssueSchema),
});
export type PulsePublishPlan = z.infer<typeof PulsePublishPlanSchema>;
export const PulseDiagnosticSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  status: z.number().optional(),
  issues: z.array(PulseValidationIssueSchema).optional(),
});
export type PulseDiagnostic = z.infer<typeof PulseDiagnosticSchema>;
const followStatus = z.enum([
  'not_attempted',
  'unknown',
  'created',
  'reused',
  'failed',
  'skipped',
]);
export const PulseFollowReceiptSchema = z.object({
  version: z.literal(1),
  requested: z.boolean(),
  group: z.object({
    status: followStatus,
    id: z.string().optional(),
    name: z.string().optional(),
    error: z.string().optional(),
    deletion: z.object({
      status: z.enum(['deleted', 'failed', 'unknown']),
      message: z.string().optional(),
    }).optional(),
  }),
  membership: z.object({ status: followStatus, error: z.string().optional() }),
  subscriptions: z.array(
    z.object({
      itemIndex: z.number().int(),
      metricId: z.string().optional(),
      status: followStatus,
      error: z.string().optional(),
    }),
  ),
});
export type PulseFollowReceipt = z.infer<typeof PulseFollowReceiptSchema>;
export const PulsePublishItemReceiptSchema = z.object({
  itemIndex: z.number().int().nonnegative(),
  name: z.string(),
  summary: PulseDefinitionSummarySchema,
  definitionId: z.string().nullable(),
  metricId: z.string().nullable(),
  creationStatus: z.enum([
    'not_attempted',
    'not_created',
    'unknown',
    'created',
  ]),
  resolutionStatus: z.enum(['pending', 'resolved', 'failed']).nullable(),
  diagnostic: PulseDiagnosticSchema.nullable(),
  undoStatus: z.enum(['pending', 'unknown', 'deleted', 'failed']).nullable(),
  undoDiagnostic: PulseDiagnosticSchema.nullable(),
});
export type PulsePublishItemReceipt = z.infer<
  typeof PulsePublishItemReceiptSchema
>;
export const PulsePublishReceiptSchema = z.object({
  id,
  context: PulseDraftContextSchema.nullable(),
  connectionId: z.string(),
  datasourceLuid: z.string(),
  datasourceName: z.string(),
  digestAudience: z.string().optional(),
  siteContentUrl: z.string().optional(),
  createdAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  publishing: z.boolean(),
  interrupted: z.boolean(),
  items: z.array(PulsePublishItemReceiptSchema),
  follow: PulseFollowReceiptSchema,
  createdCount: z.number().int(),
  unknownCount: z.number().int(),
  failedCount: z.number().int(),
  unattemptedCount: z.number().int(),
  undoEligible: z.boolean(),
});
export type PulsePublishReceipt = z.infer<typeof PulsePublishReceiptSchema>;
export const PulseAuthorProposalRequestSchema = z.object({
  baseRevision: z.number().int().positive(),
  message: z.string().trim().min(1).max(PULSE_TEXT_LIMITS.conversation),
  document: PulseWorkspaceDocumentV1Schema.optional(),
});
export const PulseAuthorProposalSchema = z.object({
  baseRevision: z.number().int().positive(),
  candidateDocument: PulseWorkspaceDocumentV1Schema,
  changes: z.array(z.object({ field: z.string(), message: z.string() })),
  assistantMessage: z.string(),
});
export type PulseAuthorProposal = z.infer<typeof PulseAuthorProposalSchema>;
export const PreparePulseDeleteRequestSchema = z.object({
  context: PulseDraftContextSchema,
  metricIds: z.array(id).max(1000),
  definitionIds: z.array(id).max(1000),
  /** Deletes selected resources by ID when Tableau cannot return their complete current inventory. */
  allowIncompleteInventory: z.boolean().default(false),
});
export const ExecutePulseDeleteRequestSchema =
  PreparePulseDeleteRequestSchema.extend({ previewFingerprint: id });
export const PulseDeletePlanSchema = z.object({
  context: PulseDraftContextSchema,
  metricIds: z.array(id),
  definitionIds: z.array(id),
  allowIncompleteInventory: z.boolean(),
  previewFingerprint: id,
  targets: z.array(
    z.object({
      kind: z.enum(['definition', 'metric']),
      id,
      name: z.string(),
      /** Null when the metric is absent from current inventory and is deleted by ID. */
      definitionId: id.nullable(),
      /** False when Tableau did not return every metric this target removes. */
      inventoryComplete: z.boolean(),
      affectedMetricIds: z.array(id),
      affectedMetrics: z.array(z.object({ id, name: z.string(), followerCount: z.number().int().nonnegative().nullable() })).optional(),
    }),
  ),
  warnings: z.array(z.string()),
});
export type PreparePulseDeleteRequest = z.infer<
  typeof PreparePulseDeleteRequestSchema
>;
export type ExecutePulseDeleteRequest = z.infer<
  typeof ExecutePulseDeleteRequestSchema
>;
export type PulseDeletePlan = z.infer<typeof PulseDeletePlanSchema>;
export const PulseVariantRequestV1Schema = z.object({
  version: z.literal(1),
  sourceMetricIds: z.array(id),
  timeframe: z
    .object({ key: id, customDays: z.number().int().positive().optional() })
    .optional(),
  clauses: z.array(
    z.object({
      fieldId: id,
      selection: z.object({
        mode: z.literal('VALUES'),
        exclude: z.boolean(),
        values: z.array(z.string()),
      }),
    }),
  ),
});
export type PulseVariantRequestV1 = z.infer<typeof PulseVariantRequestV1Schema>;
export const PulseVariantCommandSchema = PulseVariantRequestV1Schema.extend({
  context: PulseDraftContextSchema,
});
export type PulseVariantCommand = z.infer<typeof PulseVariantCommandSchema>;
export const PulseProviderDiagnosticSchema = z.object({
  message: z.string(),
  status: z.number().optional(),
  kind: z.enum(['auth', 'http', 'network']).optional(),
  detail: z.string().optional(),
});
export const PulseMetricVariantSchema = z.object({
  metricId: id,
  name: z.string(),
  measurementPeriod: z.unknown(),
  timeframeLabel: z.string(),
  filters: z.array(z.unknown()),
  comparison: z.unknown(),
  specification: z.record(z.unknown()),
  isDefault: z.boolean().nullable(),
  isScoped: z.boolean(),
  scopedState: z.enum(['default', 'filtered', 'variant', 'unknown']),
});
export const PulseDefinitionNodeSchema = z.object({
  definitionId: id,
  name: z.string(),
  description: z.string(),
  measure: z.string(),
  aggregation: z.string(),
  timeDimension: z.string(),
  metrics: z.array(PulseMetricVariantSchema),
  inventoryStatus: z.enum(['complete', 'partial', 'unavailable']),
});
export const PulseInventoryFailureSchema = z.object({
  definitionId: z.string(),
  metricId: z.string().optional(),
  stage: z.enum([
    'parse_definition',
    'list_metrics',
    'get_metric',
    'parse_metric',
  ]),
  diagnostic: PulseProviderDiagnosticSchema,
});
export const PulseInventoryResponseSchema = z.object({
  definitions: z.array(PulseDefinitionNodeSchema),
  totalScanned: z.number().int(),
  truncated: z.boolean(),
  failures: z.array(PulseInventoryFailureSchema),
});
export type PulseMetricVariant = z.infer<typeof PulseMetricVariantSchema>;
export type PulseDefinitionNode = z.infer<typeof PulseDefinitionNodeSchema>;
export type PulseInventoryResponse = z.infer<
  typeof PulseInventoryResponseSchema
>;
const availability = z.enum(['available', 'partial', 'unavailable']);
export const PulseFollowStateSchema = z.object({
  userFollowsByMetricId: z.record(z.boolean()),
  groupFollowsByMetricId: z.record(z.boolean()),
  groupFollowerIdsByMetricId: z.record(z.array(z.string())),
  userFollowerIdsByMetricId: z.record(z.array(z.string())),
  followerCountsByMetricId: z.record(z.number()),
  availabilityByMetricId: z.record(
    z.object({
      status: availability,
      relationshipStatus: availability,
      followerIdsStatus: availability.optional(),
      followerCountStatus: z.enum(['available', 'unavailable']),
      diagnostics: z.array(PulseProviderDiagnosticSchema),
    }),
  ),
  selectedGroupId: z.string().nullable(),
  groupContextUnavailable: z.boolean(),
  errors: z.array(z.string()),
});
export const PulseFollowTargetSchema = z.object({
  id,
  name: z.string().optional(),
  kind: z.enum(['GROUP', 'USER']),
});
export const PulseFollowTargetsSchema = z.object({
  targets: z.array(PulseFollowTargetSchema),
  errors: z.array(z.string()),
});
export const PulseFollowOperationSchema = z.object({
  metricId: id,
  target: PulseFollowTargetSchema.omit({ name: true }),
});
export const PulseFollowCommandSchema = z.object({
  context: PulseDraftContextSchema,
  operations: z.array(PulseFollowOperationSchema).min(1).max(200),
});
export const PulseFollowOperationResultSchema = z.object({
  metricId: id,
  targetId: id,
  targetKind: z.enum(['GROUP', 'USER']),
  status: z.enum([
    'followed',
    'already_followed',
    'unfollowed',
    'not_followed',
    'failed',
    'unknown',
    'not_attempted',
  ]),
  ok: z.boolean(),
  error: z.string().optional(),
  code: z.string().optional(),
});
export const PulseFollowResultsSchema = z.object({
  results: z.array(PulseFollowOperationResultSchema),
  terminated: z.boolean().optional(),
  stopped: z.boolean().optional(),
});
export const PulseFollowersDetailSchema = z.object({
  metricId: id,
  followers: z.array(
    z.object({
      id,
      name: z.string(),
      type: z.enum(['USER', 'GROUP', 'UNKNOWN']),
    }),
  ),
  status: availability,
  diagnostics: z.array(PulseProviderDiagnosticSchema),
  errors: z.array(z.string()),
});
export const PulseFollowersDetailsSchema = z.object({
  details: z.array(PulseFollowersDetailSchema),
});
export type PulseFollowState = z.infer<typeof PulseFollowStateSchema>;
export type PulseFollowTarget = z.infer<typeof PulseFollowTargetSchema>;
export type PulseFollowTargets = z.infer<typeof PulseFollowTargetsSchema>;
export type PulseFollowOperation = z.infer<typeof PulseFollowOperationSchema>;
export type PulseFollowOperationResult = z.infer<
  typeof PulseFollowOperationResultSchema
>;
export type PulseFollowersDetail = z.infer<typeof PulseFollowersDetailSchema>;
export const PulseVariantResultSchema = z.object({
  sourceMetricId: id,
  status: z.enum([
    'created',
    'existing',
    'failed',
    'pending_visibility',
    'visible',
    'ownership_mismatch',
  ]),
  creationStatus: z
    .enum(['created', 'existing', 'unknown', 'not_attempted'])
    .optional(),
  reconciliationStatus: z
    .enum(['visible', 'pending_visibility', 'ownership_mismatch', 'failed'])
    .optional(),
  metricId: z.string().optional(),
  requestedSpecification: z.record(z.unknown()),
  error: z.string().optional(),
});
export const PulseVariantSummarySchema = z.object({
  terminated: z.boolean().optional(),
  notAttempted: z.number().int().optional(),
  attempted: z.number().int(),
  created: z.number().int(),
  existing: z.number().int(),
  failed: z.number().int(),
  pendingVisibility: z.number().int(),
  results: z.array(PulseVariantResultSchema),
});
export type PulseVariantResult = z.infer<typeof PulseVariantResultSchema>;
export type PulseVariantSummary = z.infer<typeof PulseVariantSummarySchema>;
export const PulseDeleteResultSchema = z.object({
  definitionsDeleted: z.number().int(),
  metricsDeleted: z.number().int(),
  failures: z.array(z.string()),
  outcomes: z.array(
    z.object({
      definitionId: z.string().optional(),
      metricId: z.string().optional(),
      status: z.enum(['deleted', 'already_absent', 'failed', 'unknown', 'not_attempted']),
      error: z.string().optional(),
    }),
  ),
});
export type PulseDeleteResult = z.infer<typeof PulseDeleteResultSchema>;
export function emptyPulseDocument(): PulseWorkspaceDocumentV1 {
  return {
    metrics: {},
    slicers: {},
    digestAudience: '',
    digestAudienceLocked: false,
    groupFollow: true,
    chat: [],
  };
}

/** Bounded local history lists; full documents are loaded only by ID. */
export const PulseListQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(200).default(''),
});
export type PulseListQuery = z.infer<typeof PulseListQuerySchema>;
export const PulseDraftListQuerySchema = PulseListQuerySchema.extend({
  connectionId: id.optional(),
  serverUrl: z.string().url().optional(),
  siteId: id.optional(),
});
export type PulseDraftListQuery = z.infer<typeof PulseDraftListQuerySchema>;
export const PulseDraftSummarySchema = PulseDraftRecordSchema.omit({
  document: true,
});
export type PulseDraftSummary = z.infer<typeof PulseDraftSummarySchema>;
export const PulsePublishReceiptSummarySchema = PulsePublishReceiptSchema.omit({
  items: true,
  follow: true,
});
export type PulsePublishReceiptSummary = z.infer<
  typeof PulsePublishReceiptSummarySchema
>;
export const PulseDraftPageSchema = z.object({
  drafts: z.array(PulseDraftSummarySchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
export type PulseDraftPage = z.infer<typeof PulseDraftPageSchema>;
export const PulseReceiptPageSchema = z.object({
  receipts: z.array(PulsePublishReceiptSummarySchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
export type PulseReceiptPage = z.infer<typeof PulseReceiptPageSchema>;


export const PulseMetricPreviewRequestSchema = z.object({ context: PulseDraftContextSchema });
export type PulseMetricPreviewRequest = z.infer<typeof PulseMetricPreviewRequestSchema>;
export const PulseMetricPreviewSchema = z.object({
  metricId: id,
  definitionId: id,
  name: z.string(),
  imageDataUrl: z.string().startsWith('data:image/png;base64,').max(6 * 1024 * 1024),
  generatedAt: z.number().int(),
});
export type PulseMetricPreview = z.infer<typeof PulseMetricPreviewSchema>;
