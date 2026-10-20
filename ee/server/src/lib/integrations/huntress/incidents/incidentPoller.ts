/**
 * One poll cycle for one tenant's Huntress integration: cursor-walk new
 * incident activity (and escalation activity, when enabled), process each
 * item ascending, advance each stream's cursor only past successes, and
 * record sync status on the integration row. The streams have independent
 * cursors, so a failure in one never holds back the other.
 */

import { Knex } from 'knex';
import logger from '@alga-psa/core/logger';
import { tenantDb } from '@alga-psa/db';
import { createTenantKnex } from '@/lib/db';
import { runRmmSyncWithTransport } from '../../rmm/sync/syncOrchestration';
import { createHuntressClient } from '../huntressClient';
import type {
  HuntressEscalation,
  HuntressIncidentReport,
} from '../../../../interfaces/huntress.interfaces';
import { isRoutingConfigComplete, parseHuntressSettings, type HuntressSettings } from '../settings';
import { processEscalation } from '../escalations/escalationProcessor';
import { collectIncidentsSince, collectUpdatedSince } from './cursorWalk';
import { processIncident } from './incidentProcessor';

export interface HuntressPollInput {
  tenantId: string;
  integrationId: string;
  trigger?: 'scheduled' | 'manual';
}

export interface HuntressPollResult {
  success: boolean;
  skipped?: 'integration_not_found' | 'routing_config_incomplete' | 'missing_credentials';
  processed: number;
  failed: number;
  cursor?: string | null;
  error?: string;
  /** Present when escalation ingestion is enabled. */
  escalations?: {
    processed: number;
    failed: number;
    cursor: string | null;
    error?: string;
  };
}

export async function pollHuntressIncidents(
  input: HuntressPollInput
): Promise<HuntressPollResult> {
  const { tenantId, integrationId } = input;
  const { knex } = await createTenantKnex();
  const db = tenantDb(knex, tenantId);

  const row = await db.table('rmm_integrations')
    .where({ integration_id: integrationId, provider: 'huntress' })
    .first();
  if (!row || !row.is_active) {
    return { success: false, skipped: 'integration_not_found', processed: 0, failed: 0 };
  }

  const settings = parseHuntressSettings(row.settings);
  if (!isRoutingConfigComplete(settings)) {
    // Not an error — setup is simply unfinished. The settings UI nags instead.
    return { success: true, skipped: 'routing_config_incomplete', processed: 0, failed: 0 };
  }

  const client = await createHuntressClient(tenantId);
  if (!client) {
    await db.table('rmm_integrations')
      .where({ integration_id: integrationId })
      .update({
        sync_status: 'error',
        sync_error: 'Missing Huntress API credentials',
        updated_at: knex.fn.now(),
      });
    return {
      success: false,
      skipped: 'missing_credentials',
      processed: 0,
      failed: 0,
      error: 'Missing Huntress API credentials',
    };
  }

  await db.table('rmm_integrations')
    .where({ integration_id: integrationId })
    .update({ sync_status: 'syncing', updated_at: knex.fn.now() });

  const incidentOutcome = await runIncidentStream(knex, tenantId, integrationId, settings, client);
  const escalationOutcome = settings.ingestEscalations
    ? await runEscalationStream(knex, tenantId, integrationId, settings, client)
    : undefined;

  const failure =
    [incidentOutcome.error, escalationOutcome?.error && `Escalations: ${escalationOutcome.error}`]
      .filter(Boolean)
      .join('; ') || undefined;

  // Re-read settings before writing the cursors so config edits made while
  // the poll ran are not clobbered.
  const latest = await db.table('rmm_integrations')
    .where({ integration_id: integrationId })
    .first('settings');
  const merged = {
    ...parseHuntressSettings(latest?.settings ?? row.settings),
    incidentCursor: incidentOutcome.cursor ?? undefined,
    ...(escalationOutcome ? { escalationCursor: escalationOutcome.cursor ?? undefined } : {}),
  };

  await db.table('rmm_integrations')
    .where({ integration_id: integrationId })
    .update({
      settings: JSON.stringify(merged),
      sync_status: failure ? 'error' : 'completed',
      sync_error: failure ?? null,
      last_incremental_sync_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });

  logger.info('[Huntress] Poll cycle finished', {
    tenantId,
    integrationId,
    trigger: input.trigger ?? 'scheduled',
    collected: incidentOutcome.collected,
    processed: incidentOutcome.processed,
    failed: incidentOutcome.failed,
    ...(escalationOutcome
      ? {
          escalationsCollected: escalationOutcome.collected,
          escalationsProcessed: escalationOutcome.processed,
          escalationsFailed: escalationOutcome.failed,
        }
      : {}),
  });

  return {
    success: !failure,
    processed: incidentOutcome.processed,
    failed: incidentOutcome.failed,
    cursor: incidentOutcome.cursor,
    error: failure,
    ...(escalationOutcome
      ? {
          escalations: {
            processed: escalationOutcome.processed,
            failed: escalationOutcome.failed,
            cursor: escalationOutcome.cursor,
            error: escalationOutcome.error,
          },
        }
      : {}),
  };
}

interface StreamOutcome {
  collected: number;
  processed: number;
  failed: number;
  cursor: string | null;
  error?: string;
}

type HuntressClientInstance = NonNullable<Awaited<ReturnType<typeof createHuntressClient>>>;

/**
 * Process items ascending, stopping at the first failure so it is retried
 * next cycle; the cursor only advances past successes.
 */
async function processInOrder<T extends { updated_at: string }>(
  items: T[],
  startCursor: string | null,
  processOne: (item: T) => Promise<{ ok: boolean; error?: string }>,
  label: string
): Promise<StreamOutcome> {
  let processed = 0;
  let cursor = startCursor;
  for (const item of items) {
    const result = await processOne(item);
    if (!result.ok) {
      return {
        collected: items.length,
        processed,
        failed: 1,
        cursor,
        error: result.error ?? `${label} processing failed`,
      };
    }
    processed += 1;
    if (!cursor || Date.parse(item.updated_at) > Date.parse(cursor)) {
      cursor = item.updated_at;
    }
  }
  return { collected: items.length, processed, failed: 0, cursor };
}

async function runIncidentStream(
  knex: Knex,
  tenantId: string,
  integrationId: string,
  settings: HuntressSettings,
  client: HuntressClientInstance
): Promise<StreamOutcome> {
  const startCursor = settings.incidentCursor ?? null;
  let incidents: HuntressIncidentReport[];
  try {
    incidents = await collectIncidentsSince(
      async (pageToken) => {
        const page = await client.listIncidentReportsPage({ page_token: pageToken });
        return {
          incidents: page.incident_reports ?? [],
          nextPageToken: page.pagination?.next_page_token ?? undefined,
        };
      },
      { cursorIso: startCursor, backfillDays: settings.backfillDays }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[Huntress] Incident list failed', { tenantId, error: message });
    return { collected: 0, processed: 0, failed: 0, cursor: startCursor, error: message };
  }

  const deps = {
    getAgent: (id: number) => client.getAgent(id),
    getOrganization: (id: number) => client.getOrganization(id),
  };
  return processInOrder(
    incidents,
    startCursor,
    (incident) =>
      processIncident(knex, tenantId, { integration_id: integrationId, settings }, incident, deps),
    'Incident'
  );
}

async function runEscalationStream(
  knex: Knex,
  tenantId: string,
  integrationId: string,
  settings: HuntressSettings,
  client: HuntressClientInstance
): Promise<StreamOutcome> {
  const startCursor = settings.escalationCursor ?? null;
  let escalations: HuntressEscalation[];
  try {
    escalations = await collectUpdatedSince(
      async (pageToken) => {
        const page = await client.listEscalationsPage({ page_token: pageToken });
        return {
          items: page.escalations ?? [],
          nextPageToken: page.pagination?.next_page_token ?? undefined,
        };
      },
      { cursorIso: startCursor, backfillDays: settings.backfillDays }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[Huntress] Escalation list failed', { tenantId, error: message });
    return { collected: 0, processed: 0, failed: 0, cursor: startCursor, error: message };
  }

  const deps = {
    getEscalation: (id: number) => client.getEscalation(id),
    getAgent: (id: number) => client.getAgent(id),
    getOrganization: (id: number) => client.getOrganization(id),
  };
  return processInOrder(
    escalations,
    startCursor,
    (escalation) =>
      processEscalation(
        knex,
        tenantId,
        { integration_id: integrationId, settings },
        escalation,
        deps
      ),
    'Escalation'
  );
}

/**
 * Transport-wrapped entry point (HUNTRESS_SYNC_TRANSPORT → RMM_SYNC_TRANSPORT
 * → 'direct'). No Temporal workflow exists yet — leave the transport unset or
 * 'direct' until one is added.
 */
export async function runHuntressIncidentPoll(
  input: HuntressPollInput
): Promise<HuntressPollResult> {
  return runRmmSyncWithTransport<HuntressPollInput, HuntressPollResult>({
    context: { provider: 'huntress', operation: 'incident_poll', input },
    directExecutor: async (context) => pollHuntressIncidents(context.input),
  });
}
