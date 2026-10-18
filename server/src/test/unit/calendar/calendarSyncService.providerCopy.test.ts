import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mappings: [] as Array<Record<string, any>>,
  entry: null as any,
  deleteEvent: vi.fn(),
  entryDelete: vi.fn(),
  canEdit: true,
}));

vi.mock('@alga-psa/db', () => {
  const table = (name: string) => {
    if (name !== 'calendar_event_mappings') {
      // users resolves the provider owner; calendars has no archived group calendar.
      return { where: () => ({ first: async () => (name === 'users' ? { user_id: 'user-1', user_type: 'internal' } : undefined) }) };
    }
    const filters: Array<(row: Record<string, any>) => boolean> = [];
    const query: any = {
      where: (column: string | Record<string, any>, value?: unknown) => {
        if (typeof column === 'string') filters.push((row) => row[column] === value);
        else filters.push((row) => Object.entries(column).every(([key, val]) => row[key] === val));
        return query;
      },
      andWhere: (column: string, value: unknown) => query.where(column, value),
      first: async () => state.mappings.find((row) => filters.every((filter) => filter(row))),
      del: async () => {
        const before = state.mappings.length;
        state.mappings = state.mappings.filter((row) => !filters.every((filter) => filter(row)));
        return before - state.mappings.length;
      },
      insert: async (row: Record<string, any>) => { state.mappings.push({ ...row }); return [row]; },
    };
    return query;
  };
  return {
    createTenantKnex: async () => ({ knex: {}, tenant: 'tenant-1' }),
    tenantDb: () => ({ table }),
    withTransaction: async (knex: unknown, callback: (trx: unknown) => unknown) => callback(knex),
  };
});
vi.mock('@alga-psa/shared/models/scheduleEntry', () => ({
  default: {
    get: async () => state.entry,
    delete: async (...args: unknown[]) => { state.entryDelete(...args); return true; },
    update: async () => state.entry,
  },
}));
vi.mock('@alga-psa/auth', () => ({ hasPermission: vi.fn(async () => false) }));
vi.mock('@alga-psa/scheduling/lib/calendarAccess', () => ({
  resolveCalendarAccess: vi.fn(async () => ({})),
  evaluateEntryAccess: vi.fn(() => ({ access: 'full', canEdit: state.canEdit })),
}));
vi.mock('@alga-psa/event-bus/publishers', () => ({ publishEvent: vi.fn(), publishWorkflowEvent: vi.fn() }));
vi.mock('@alga-psa/ee-calendar/lib/eventBus/publishers', () => ({ publishEvent: vi.fn() }));
vi.mock('@alga-psa/ee-calendar/lib/services/calendar/CalendarProviderService', () => ({
  CalendarProviderService: class {
    async getProvider() {
      return {
        id: 'provider-1', tenant: 'tenant-1', user_id: 'user-1', provider_type: 'google',
        provider_config: { accessToken: 'a', refreshToken: 'r' },
      };
    }
    async updateProvider() {}
  },
}));
vi.mock('@alga-psa/ee-calendar/lib/services/calendar/providers/GoogleCalendarAdapter', () => ({
  GoogleCalendarAdapter: class {
    async connect() {}
    async deleteEvent(...args: unknown[]) { return state.deleteEvent(...args); }
  },
}));
vi.mock('@alga-psa/ee-calendar/lib/services/calendar/providers/MicrosoftCalendarAdapter', () => ({ MicrosoftCalendarAdapter: class {} }));

import { CalendarSyncService } from '@alga-psa/ee-calendar/lib/services/calendar/CalendarSyncService';

const mapping = {
  id: 'mapping-1', tenant: 'tenant-1', calendar_provider_id: 'provider-1',
  schedule_entry_id: 'entry-1', external_event_id: 'event-1', sync_status: 'synced',
};

describe('CalendarSyncService provider copies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.mappings = [{ ...mapping }];
    state.entry = { entry_id: 'entry-1', calendar_id: null, is_private: true, assigned_user_ids: ['user-1'] };
    state.canEdit = true;
  });

  it('removes the provider copy without notifying attendees, keeps the entry, and leaves no mapping for the delete echo', async () => {
    let mappingDuringDelete: unknown = 'not called';
    state.deleteEvent.mockImplementation(async () => {
      // A provider delete notification is matched on the external event ID.
      mappingDuringDelete = state.mappings.find((row) => row.external_event_id === 'event-1');
    });

    await new CalendarSyncService().removeProviderCopy('entry-1', 'provider-1');

    expect(state.deleteEvent).toHaveBeenCalledWith('event-1', { notifyAttendees: false });
    expect(mappingDuringDelete).toBeUndefined();
    expect(state.mappings).toEqual([]);
    expect(state.entryDelete).not.toHaveBeenCalled();
  });

  it('restores the mapping when the provider copy could not be deleted', async () => {
    state.deleteEvent.mockRejectedValue(Object.assign(new Error('Backend error'), { status: 500 }));

    await expect(new CalendarSyncService().removeProviderCopy('entry-1', 'provider-1')).rejects.toThrow('Backend error');

    expect(state.mappings).toEqual([mapping]);
    expect(state.entryDelete).not.toHaveBeenCalled();
  });

  it('drops the mapping when the provider copy is already gone', async () => {
    state.deleteEvent.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));

    await new CalendarSyncService().removeProviderCopy('entry-1', 'provider-1');

    expect(state.mappings).toEqual([]);
  });

  it('still deletes a personal single-assignee entry when the user deletes it in their calendar', async () => {
    const result = await new CalendarSyncService().handleInboundProviderDelete('entry-1', 'provider-1');

    expect(result).toEqual({ success: true });
    expect(state.entryDelete).toHaveBeenCalledWith(expect.anything(), 'tenant-1', 'entry-1');
    expect(state.deleteEvent).not.toHaveBeenCalled();
    expect(state.mappings).toEqual([]);
  });

  it('only drops the mapping when the deleted copy belongs to a user who is no longer assigned', async () => {
    state.entry = { ...state.entry, calendar_id: 'group-1', is_private: false, assigned_user_ids: ['user-a'] };

    const result = await new CalendarSyncService().handleInboundProviderDelete('entry-1', 'provider-1');

    expect(result).toEqual({ success: true });
    expect(state.entryDelete).not.toHaveBeenCalled();
    expect(state.mappings).toEqual([]);
  });
});
