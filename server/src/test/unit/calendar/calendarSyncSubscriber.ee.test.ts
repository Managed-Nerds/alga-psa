import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  providers: [] as any[],
  providerErrors: [] as Error[],
  syncCalls: [] as Array<{ entryId: string; providerId: string }>,
  deleteCalls: [] as Array<{ entryId: string; providerId: string; scope: string }>,
  removeCalls: [] as Array<{ entryId: string; providerId: string }>,
}));

const eventHandlers = vi.hoisted(() => new Map<string, Set<(event: any) => Promise<void>>>());

vi.mock('@alga-psa/event-bus', () => ({
  getEventBus: () => ({
    subscribe: async (eventType: string, handler: (event: any) => Promise<void>) => {
      const handlers = eventHandlers.get(eventType) ?? new Set();
      handlers.add(handler);
      eventHandlers.set(eventType, handlers);
    },
  }),
}));

vi.mock('@alga-psa/db', () => ({
  createTenantKnex: async () => ({
    knex: vi.fn(),
    tenant: 'tenant-1',
  }),
  runWithTenant: async (_tenant: string, callback: () => Promise<any>) => callback(),
}));

vi.mock('@alga-psa/email', () => ({
  TenantEmailService: {
    sendEmail: vi.fn(async () => undefined),
  },
  StaticTemplateProcessor: class {},
}));

vi.mock('@alga-psa/ee-calendar/lib/services/calendar/CalendarProviderService', () => ({
  CalendarProviderService: class {
    async getProviders() {
      const error = shared.providerErrors.shift();
      if (error) throw error;
      return shared.providers;
    }
  },
}));

vi.mock('@alga-psa/ee-calendar/lib/services/calendar/CalendarSyncService', () => ({
  CalendarSyncService: class {
    async syncScheduleEntryToExternal(entryId: string, providerId: string) {
      shared.syncCalls.push({ entryId, providerId });
      return { success: true, externalEventId: `ext-${entryId}` };
    }

    async deleteScheduleEntry(entryId: string, providerId: string, scope: string) {
      shared.deleteCalls.push({ entryId, providerId, scope });
      return { success: true };
    }

    async removeProviderCopy(entryId: string, providerId: string) {
      shared.removeCalls.push({ entryId, providerId });
    }
  },
}));

async function publish(eventType: string, payload: Record<string, any>) {
  const handlers = eventHandlers.get(eventType);
  if (!handlers) {
    return;
  }

  for (const handler of handlers) {
    await handler({
      id: `event-${eventType}`,
      timestamp: new Date().toISOString(),
      eventType,
      payload,
    });
  }
}

describe('enterprise calendarSyncSubscriber', () => {
  beforeEach(() => {
    eventHandlers.clear();
    shared.syncCalls.length = 0;
    shared.deleteCalls.length = 0;
    shared.removeCalls.length = 0;
    shared.providerErrors.length = 0;
    shared.providers = [
      {
        id: 'provider-1',
        tenant: 'tenant-1',
        user_id: 'user-1',
        sync_direction: 'bidirectional',
      },
    ];
  });

  it('syncs assigned schedule entries to active providers when registered', async () => {
    const subscriberModule = await import('@alga-psa/ee-calendar/event-bus');

    await subscriberModule.registerCalendarSyncSubscriber();
    await publish('SCHEDULE_ENTRY_CREATED', {
      entryId: 'entry-1',
      tenantId: 'tenant-1',
      changes: {
        assignedUserIds: ['user-1'],
      },
    });

    expect(shared.syncCalls).toEqual([{ entryId: 'entry-1', providerId: 'provider-1' }]);
  });

  it('rejects a transient provider lookup failure so the event bus can redeliver it', async () => {
    const subscriberModule = await import('@alga-psa/ee-calendar/event-bus');
    shared.providerErrors.push(new Error(
      'Knex: Timeout acquiring a connection. The pool is probably full.',
    ));

    await subscriberModule.registerCalendarSyncSubscriber();
    const payload = {
      entryId: 'entry-retry',
      tenantId: 'tenant-1',
      changes: { assignedUserIds: ['user-1'] },
    };

    await expect(publish('SCHEDULE_ENTRY_CREATED', payload)).rejects.toThrow(
      'Timeout acquiring a connection',
    );
    expect(shared.syncCalls).toEqual([]);

    await publish('SCHEDULE_ENTRY_CREATED', payload);
    expect(shared.syncCalls).toEqual([
      { entryId: 'entry-retry', providerId: 'provider-1' },
    ]);
  });

  it('removes schedule entries from assigned calendars on delete events', async () => {
    const subscriberModule = await import('@alga-psa/ee-calendar/event-bus');

    await subscriberModule.registerCalendarSyncSubscriber();
    await publish('SCHEDULE_ENTRY_DELETED', {
      entryId: 'entry-2',
      tenantId: 'tenant-1',
      changes: {
        before: {
          assignedUserIds: ['user-1'],
        },
      },
    });

    expect(shared.deleteCalls).toEqual([
      {
        entryId: 'entry-2',
        providerId: 'provider-1',
        scope: 'all',
      },
    ]);
  });

  it('keeps a moved entry when its calendar changes and only updates the provider copy', async () => {
    const subscriberModule = await import('@alga-psa/ee-calendar/event-bus');

    await subscriberModule.registerCalendarSyncSubscriber();
    for (const [beforeCalendar, afterCalendar] of [[null, 'group-1'], ['group-1', null]]) {
      await publish('SCHEDULE_ENTRY_UPDATED', {
        entryId: 'entry-move',
        tenantId: 'tenant-1',
        changes: {
          before: { assignedUserIds: ['user-1'], calendarId: beforeCalendar, isPrivate: !beforeCalendar },
          after: { assignedUserIds: ['user-1'], calendarId: afterCalendar, isPrivate: false },
        },
      });
    }

    expect(shared.syncCalls).toEqual([
      { entryId: 'entry-move', providerId: 'provider-1' },
      { entryId: 'entry-move', providerId: 'provider-1' },
    ]);
    expect(shared.deleteCalls).toEqual([]);
    expect(shared.removeCalls).toEqual([]);
  });

  it('removes only the unassigned user\'s provider copy and never deletes the entry', async () => {
    shared.providers = [
      { id: 'provider-a', tenant: 'tenant-1', user_id: 'user-a', sync_direction: 'bidirectional' },
      { id: 'provider-b', tenant: 'tenant-1', user_id: 'user-b', sync_direction: 'bidirectional' },
    ];
    const subscriberModule = await import('@alga-psa/ee-calendar/event-bus');

    await subscriberModule.registerCalendarSyncSubscriber();
    await publish('SCHEDULE_ENTRY_UPDATED', {
      entryId: 'entry-ab',
      tenantId: 'tenant-1',
      changes: {
        before: { assignedUserIds: ['user-a', 'user-b'] },
        after: { assignedUserIds: ['user-a'] },
      },
    });

    expect(shared.removeCalls).toEqual([{ entryId: 'entry-ab', providerId: 'provider-b' }]);
    expect(shared.syncCalls).toEqual([{ entryId: 'entry-ab', providerId: 'provider-a' }]);
    expect(shared.deleteCalls).toEqual([]);
  });

  it('does not treat an update without reported assignees as an unassignment', async () => {
    const subscriberModule = await import('@alga-psa/ee-calendar/event-bus');

    await subscriberModule.registerCalendarSyncSubscriber();
    await publish('SCHEDULE_ENTRY_UPDATED', {
      entryId: 'entry-raw',
      tenantId: 'tenant-1',
      changes: {
        before: { assignedUserIds: ['user-1'] },
        after: { calendar_id: 'group-1' },
      },
    });

    expect(shared.deleteCalls).toEqual([]);
    expect(shared.removeCalls).toEqual([]);
  });
});
