import type { TableauSession } from '@pulse-metric-studio/core';
import {
  batchCreateGroupSubscriptions,
  batchCreateUserSubscriptions,
  batchCreateSubscriptions,
  type SubscriptionWriteResult,
  type SubscriptionWriteTarget,
  batchGetFollowerCounts,
  deleteSubscription,
  getPulseMetric,
  getTableauUserName,
  listDefinitionsInventory,
  listMetricsInventory,
  listSubscriptionsForMetric,
  listTableauGroups,
  listTableauUsers,
  type FollowerCountBatchResult,
  type PulseDefinitionInventory,
  type PulseExactMetric,
  type PulseMetricInventory,
  type SubscriptionRecord,
} from '../pulse/pulse-client.js';

export interface PulseRegistryDependencies {
  createSubscriptions?(session: TableauSession, items: SubscriptionWriteTarget[]): Promise<SubscriptionWriteResult[]>;
  listDefinitions(session: TableauSession): Promise<PulseDefinitionInventory>;
  listMetrics(
    session: TableauSession,
    definitionId: string,
  ): Promise<PulseExactMetric[] | PulseMetricInventory>;
  getMetric(
    session: TableauSession,
    metricId: string,
  ): Promise<PulseExactMetric>;
  listSubscriptions(
    session: TableauSession,
    metricId: string,
  ): Promise<SubscriptionRecord[]>;
  createGroupSubscriptions(
    session: TableauSession,
    items: Array<{ metricId: string; groupId: string }>,
  ): Promise<
    Array<{
      metricId: string;
      targetId: string;
      ok: boolean;
      alreadyExists: boolean;
      error?: string;
      unknown?: boolean;
    }>
  >;
  createUserSubscriptions(
    session: TableauSession,
    items: Array<{ metricId: string; userId: string }>,
  ): Promise<
    Array<{
      metricId: string;
      targetId: string;
      ok: boolean;
      alreadyExists: boolean;
      error?: string;
      unknown?: boolean;
    }>
  >;
  deleteSubscription(
    session: TableauSession,
    subscriptionId: string,
  ): Promise<void>;
  followerCounts(
    session: TableauSession,
    metricIds: string[],
  ): Promise<FollowerCountBatchResult>;
  getUserName(session: TableauSession, userId: string): Promise<string | null>;
  listGroups(
    session: TableauSession,
  ): Promise<Array<{ id: string; name: string }>>;
  listUsers(
    session: TableauSession,
  ): Promise<Array<{ id: string; name: string }>>;
}

export const defaultDependencies: PulseRegistryDependencies = {
  createSubscriptions: batchCreateSubscriptions,
  listDefinitions: listDefinitionsInventory,
  listMetrics: listMetricsInventory,
  getMetric: getPulseMetric,
  listSubscriptions: listSubscriptionsForMetric,
  createGroupSubscriptions: batchCreateGroupSubscriptions,
  createUserSubscriptions: batchCreateUserSubscriptions,
  deleteSubscription,
  followerCounts: batchGetFollowerCounts,
  getUserName: getTableauUserName,
  listGroups: listTableauGroups,
  listUsers: listTableauUsers,
};

export type InventoryDependencies = Pick<
  PulseRegistryDependencies,
  'listDefinitions' | 'listMetrics' | 'getMetric'
>;
export type SubscriptionDependencies = Pick<
  PulseRegistryDependencies,
  | 'listSubscriptions'
  | 'createSubscriptions'
  | 'createGroupSubscriptions'
  | 'createUserSubscriptions'
  | 'deleteSubscription'
  | 'followerCounts'
  | 'getUserName'
  | 'listGroups'
  | 'listUsers'
>;
