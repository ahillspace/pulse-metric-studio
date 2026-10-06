import type { DatasourceCatalog, FieldExclusionReason } from '@pulse-metric-studio/shared';
import type { TableauSession } from './rest-client.js';
import { TableauError, postJson } from './rest-client.js';
import { normalizeVdsToCatalog, type VdsField } from './vds-fields.js';

/**
 * Metadata API GraphQL fallback — a faithful port of the reference implementation
 * classifier. VDS (see vds-fields.ts) is the primary, fast path; this fires
 * only when a pod lacks VDS access, or to enrich calc captions that VDS returns
 * as the internal `Calculation_NNN` id (the published-on-published / sqlproxy
 * edge case). It is slow on Cloud (search-index hydration lag), hence fallback.
 *
 * Unlike VDS, the Metadata API carries no `columnClass`/`defaultAggregation`, so
 * classification here is formula-based AND dependency-aware: a calc is excluded
 * not only when its own formula is a table calc / blend, but when it references
 * (directly or transitively) any field that is. `requiresUserAgg` propagates the
 * same way. This is the "strong logic" the VDS path replaces with columnClass.
 */

interface GraphqlNode {
  __typename?: string | null;
  id?: string;
  name?: string;
  fullyQualifiedName?: string;
  description?: string | null;
  role?: string;
  dataType?: string;
  aggregation?: string | null;
  formula?: string | null;
  isHidden?: boolean;
}

// Relay/connection shape with inline fragments, matching the reference. `$luid`
// is `String!` (this pod rejects `ID!`); fields come via `fieldsConnection.nodes`.
const DATASOURCE_FIELDS_QUERY = `
query GetDs($luid: String!, $first: Int!, $after: String) {
  publishedDatasources(filter: { luid: $luid }) {
    luid
    name
    fieldsConnection(first: $first, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        id
        name
        fullyQualifiedName
        description
        isHidden
        ... on ColumnField { role dataType aggregation }
        ... on CalculatedField { role dataType aggregation formula }
      }
    }
  }
}`;

const PAGE_SIZE = 1000;

// ── Table-calc detection (full reference function list) ──
const TABLE_CALC_FUNCTIONS = [
  'FIRST', 'INDEX', 'LAST', 'LOOKUP',
  'MODEL_EXTENSION_BOOL', 'MODEL_EXTENSION_INT', 'MODEL_EXTENSION_REAL', 'MODEL_EXTENSION_STR',
  'MODEL_PERCENTILE', 'MODEL_QUANTILE',
  'PREVIOUS_VALUE',
  'RANK', 'RANK_DENSE', 'RANK_MODIFIED', 'RANK_PERCENTILE', 'RANK_UNIQUE',
  'RUNNING_AVG', 'RUNNING_COUNT', 'RUNNING_MAX', 'RUNNING_MIN', 'RUNNING_SUM',
  'SCRIPT_BOOL', 'SCRIPT_INT', 'SCRIPT_REAL', 'SCRIPT_STR',
  'SIZE', 'TOTAL',
  'WINDOW_AVG', 'WINDOW_CORR', 'WINDOW_COUNT', 'WINDOW_COVAR', 'WINDOW_COVARP',
  'WINDOW_MAX', 'WINDOW_MEDIAN', 'WINDOW_MIN', 'WINDOW_PERCENTILE', 'WINDOW_STDEV', 'WINDOW_STDEVP',
  'WINDOW_SUM', 'WINDOW_VAR', 'WINDOW_VARP',
];
const tableCalcRe = new RegExp(`\\b(?:${TABLE_CALC_FUNCTIONS.join('|')})\\s*\\(`, 'i');

export function isTableCalcFormula(formula: string | null | undefined): boolean {
  return !!formula && tableCalcRe.test(formula);
}

// ── requiresUserAgg detection: an aggregation call OUTSIDE any {} LOD block ──
const userAggRe = /\b(?:SUM|AVG|MIN|MAX|COUNT|COUNTD|MEDIAN|ATTR|STDEV|STDEVP|VAR|VARP)\s*\(/i;

function stripCurlyBlocks(formula: string): string {
  let result = '';
  let depth = 0;
  for (let i = 0; i < formula.length; i++) {
    if (formula[i] === '{') { depth++; continue; }
    if (formula[i] === '}') { if (depth > 0) depth--; continue; }
    result += depth === 0 ? formula[i] : ' ';
  }
  return result;
}

export function requiresUserAggFromFormula(formula: string | null | undefined): boolean {
  if (!formula) return false;
  return userAggRe.test(stripCurlyBlocks(formula));
}

// ── Formula reference scanning: strip string literals + comments before scan ──
function prepareFormulaForRefScan(formula: string | null | undefined): string {
  if (!formula) return '';
  let result = '';
  let i = 0;
  while (i < formula.length) {
    const start = i;
    const ch = formula[i];
    if (ch === '[') {
      // Quotes and comment delimiters inside an identifier are ordinary characters.
      const close = formula.indexOf(']', i + 1);
      i = close < 0 ? formula.length : close + 1;
      result += formula.slice(start, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < formula.length) {
        if (formula[i] === '\\') { i = Math.min(i + 2, formula.length); continue; }
        if (formula[i] === ch) {
          i++;
          if (formula[i] === ch) { i++; continue; }
          break;
        }
        i++;
      }
    } else if (ch === '/' && formula[i + 1] === '/') {
      i += 2;
      while (i < formula.length && formula[i] !== '\n') i++;
    } else if (ch === '/' && formula[i + 1] === '*') {
      const close = formula.indexOf('*/', i + 2);
      i = close < 0 ? formula.length : close + 2;
    } else {
      result += ch;
      i++;
      continue;
    }
    result += ' '.repeat(i - start);
  }
  return result;
}

/** Extract bracket-reference chains: `[A]`->["A"], `[A].[B]`->["A","B"]. */
function extractBracketRefChains(prepped: string): Array<{ parts: string[] }> {
  const chains: Array<{ parts: string[] }> = [];
  let i = 0;
  while (i < prepped.length) {
    if (prepped[i] === '[') {
      const parts: string[] = [];
      while (i < prepped.length && prepped[i] === '[') {
        const closeIdx = prepped.indexOf(']', i + 1);
        if (closeIdx === -1) { i = prepped.length; break; }
        parts.push(prepped.substring(i + 1, closeIdx));
        i = closeIdx + 1;
        let j = i;
        while (j < prepped.length && prepped[j] === ' ') j++;
        if (j < prepped.length && prepped[j] === '.') {
          let k = j + 1;
          while (k < prepped.length && prepped[k] === ' ') k++;
          if (k < prepped.length && prepped[k] === '[') { i = k; continue; }
        }
        break;
      }
      if (parts.length > 0) chains.push({ parts });
    } else {
      i++;
    }
  }
  return chains;
}

export function detectBlendedRef(prepped: string): boolean {
  return extractBracketRefChains(prepped).some((c) => c.parts.length >= 2);
}

/** Referenced field names = last part of each bracket chain. */
function listReferencedFieldNames(prepped: string): Set<string> {
  const names = new Set<string>();
  for (const c of extractBracketRefChains(prepped)) names.add(c.parts[c.parts.length - 1]);
  return names;
}

/** Tableau-internal metadata records that cannot be Pulse fields. */
function getInternalFieldReason(node: GraphqlNode): string | null {
  const fqn = String(node.fullyQualifiedName || '');
  const fqnLower = fqn.toLowerCase();
  const dataType = String(node.dataType || '').toUpperCase();
  if (fqnLower.includes('__tableau_internal_object_id__')) return 'object-id';
  if (dataType === 'TABLE') return 'table-ref';
  if (/^\[__[^\]]+__\](?:\.\[.*\])?$/i.test(fqn)) return 'internal-namespace';
  if (/\[__[^\]]+__\]/i.test(fqn)) return 'internal-namespace';
  return null;
}

/**
 * Canonical Pulse identifier: the raw name Pulse resolves refs by (never the
 * caption). `[Calculation_NNN]` -> `Calculation_NNN`; single-bracket FQN -> its
 * inner value; otherwise the friendly name.
 */
export function canonicalPulseIdentifier(node: GraphqlNode): string {
  const fqn = String(node.fullyQualifiedName || '').trim();
  const name = String(node.name || '').trim();
  if (node.__typename === 'CalculatedField') {
    const calcMatch = fqn.match(/^\[(Calculation_\d+)\]$/i);
    if (calcMatch) return calcMatch[1];
    const single = fqn.match(/^\[([^\]]+)\]$/);
    if (single) return single[1];
    return name;
  }
  if (fqn) {
    const single = fqn.match(/^\[([^\]]+)\]$/);
    if (single) return single[1];
    if (!fqn.includes('][')) return fqn;
  }
  return name;
}

interface Analysis {
  node: GraphqlNode;
  graphName: string;
  isCalc: boolean;
  internalReason: string | null;
  isTableCalc: boolean;
  isBlendedCalc: boolean;
  directRequiresUserAgg: boolean;
  referencedNames: Set<string>;
  disallowed: boolean;
  disallowReason: FieldExclusionReason | null;
  requiresUserAgg: boolean;
}

/**
 * Classify GraphQL nodes into VdsField rows with precomputed exclusion /
 * requiresUserAgg hints, running both fixed-point propagation passes. Hidden
 * fields participate in dependency analysis and are omitted only from the projection.
 */
export function classifyGraphqlNodes(nodes: GraphqlNode[]): VdsField[] {
  const analysis: Analysis[] = nodes
    .map((node) => {
      const isCalc = !!node.formula;
      const prepped = isCalc ? prepareFormulaForRefScan(node.formula) : '';
      const internalReason = getInternalFieldReason(node);
      return {
        node,
        graphName: String(node.name ?? '').trim(),
        isCalc,
        internalReason,
        isTableCalc: isTableCalcFormula(node.formula),
        isBlendedCalc: isCalc && detectBlendedRef(prepped),
        directRequiresUserAgg: requiresUserAggFromFormula(node.formula),
        referencedNames: isCalc ? listReferencedFieldNames(prepped) : new Set<string>(),
        disallowed: false,
        disallowReason: null as FieldExclusionReason | null,
        requiresUserAgg: false,
      };
    });

  // name -> entries (names can collide across logical tables)
  const nameToEntries = new Map<string, Analysis[]>();
  for (const entry of analysis) {
    if (!entry.graphName) continue;
    const list = nameToEntries.get(entry.graphName) ?? [];
    list.push(entry);
    nameToEntries.set(entry.graphName, list);
  }

  // Pass 1: disallowed propagation (seeds: internal, table calc, blend).
  for (const entry of analysis) {
    if (entry.internalReason) { entry.disallowed = true; entry.disallowReason = 'internal'; }
    else if (entry.isTableCalc) { entry.disallowed = true; entry.disallowReason = 'table_calc'; }
    else if (entry.isBlendedCalc) { entry.disallowed = true; entry.disallowReason = 'blend_ref'; }
  }
  const maxPasses = analysis.filter((e) => e.isCalc).length + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const entry of analysis) {
      if (entry.disallowed || !entry.isCalc) continue;
      for (const refName of entry.referencedNames) {
        const candidates = nameToEntries.get(refName);
        if (!candidates) continue;
        // Conservative: if ANY same-named field is disallowed, taint this one,
        // carrying the reason forward so a calc wrapping a table calc reads as
        // table_calc (not an untyped "tainted").
        const bad = candidates.find((c) => c.disallowed);
        if (bad) {
          entry.disallowed = true;
          entry.disallowReason = bad.disallowReason ?? 'table_calc';
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  // Pass 2: requiresUserAgg propagation among allowed fields.
  for (const entry of analysis) {
    if (!entry.disallowed) entry.requiresUserAgg = entry.directRequiresUserAgg;
  }
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const entry of analysis) {
      if (entry.disallowed || !entry.isCalc || entry.requiresUserAgg) continue;
      for (const refName of entry.referencedNames) {
        const candidates = nameToEntries.get(refName);
        if (!candidates) continue;
        if (candidates.some((c) => !c.disallowed && c.requiresUserAgg)) {
          entry.requiresUserAgg = true;
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  return analysis.filter((entry) => entry.node.isHidden !== true).map((entry) => ({
    name: canonicalPulseIdentifier(entry.node),
    // Metadata API returns the human caption in `name`; the raw id lives in the
    // FQN (extracted into `name` above). Carry the caption for display.
    caption: entry.node.name ?? canonicalPulseIdentifier(entry.node),
    dataType: entry.node.dataType,
    physicalType: entry.node.dataType ?? null,
    columnClass: entry.isCalc ? 'CALCULATION' : 'COLUMN',
    defaultAggregation: entry.node.aggregation ?? null,
    formula: entry.node.formula ?? null,
    role: entry.node.role === 'MEASURE' ? 'MEASURE' : 'DIMENSION',
    logicalTableId: null,
    exclusionHint: entry.disallowed ? entry.disallowReason : null,
    requiresUserAggHint: entry.requiresUserAgg,
  }));
}

/** Fetch every field node across all pages. Returns null when the pod has no
 *  Metadata API / the datasource is not indexed; rethrows auth errors. */
async function fetchGraphqlNodes(
  session: TableauSession,
  luid: string,
): Promise<{ name?: string; nodes: GraphqlNode[] } | null> {
  const nodes: GraphqlNode[] = [];
  let hasNextPage = true;
  let after: string | null = null;
  let dsName: string | undefined;

  while (hasNextPage) {
    const data = (await postJson<any>(
      session,
      '/api/metadata/graphql',
      { query: DATASOURCE_FIELDS_QUERY, variables: { luid, first: PAGE_SIZE, after } },
      { contentType: 'application/json', accept: 'application/json' },
    ).catch((e) => {
      if (e instanceof TableauError && e.kind === 'auth') throw e;
      return null;
    })) as any;

    const pub = data?.data?.publishedDatasources?.[0];
    if (!pub) return null;
    dsName = pub.name ?? dsName;
    const conn = pub.fieldsConnection ?? {};
    for (const node of (conn.nodes ?? []) as GraphqlNode[]) nodes.push(node);
    const pageInfo = conn.pageInfo ?? {};
    hasNextPage = pageInfo.hasNextPage === true;
    after = pageInfo.endCursor ?? null;
    if (hasNextPage && !after) break; // malformed pagination guard
  }

  return { name: dsName, nodes };
}

export async function fetchFieldsViaMetadataGraphql(
  session: TableauSession,
  luid: string,
  ds: { luid: string; name: string },
): Promise<DatasourceCatalog> {
  const result = await fetchGraphqlNodes(session, luid);
  if (!result) {
    throw new TableauError('Field metadata unavailable (VDS and Metadata API both failed)', 502);
  }

  const fields = classifyGraphqlNodes(result.nodes);
  return normalizeVdsToCatalog(
    { fieldGroups: [{ logicalTableId: null, fields }], fieldProvenance: 'metadata_graphql' },
    { luid, name: result.name ?? ds.name },
    'metadata',
  );
}

/**
 * Best-effort map of canonical id -> friendly caption, used to repair VDS calc
 * captions that came back as the internal `Calculation_NNN` id. Never throws
 * (except auth); returns an empty map when the Metadata API is unavailable or
 * not yet hydrated.
 */
export async function fetchCaptionMap(session: TableauSession, luid: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const result = await fetchGraphqlNodes(session, luid).catch((e) => {
    if (e instanceof TableauError && e.kind === 'auth') throw e;
    return null;
  });
  if (!result) return map;
  for (const node of result.nodes) {
    const id = canonicalPulseIdentifier(node);
    const friendly = String(node.name ?? '').trim();
    if (id && friendly && friendly !== id) map.set(id, friendly);
  }
  return map;
}
