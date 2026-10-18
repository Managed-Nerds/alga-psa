import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  entry: {} as Record<string, unknown>,
  assignees: [] as string[],
  calendars: {} as Record<string, { calendar_id: string; calendar_type: string; is_archived: boolean; name: string; color: string | null }>,
  update: vi.fn(),
  create: vi.fn(),
  publish: vi.fn(),
  access: null as any,
}));

vi.mock('@alga-psa/db', () => ({
  BaseService: class { async getKnex() { return { knex: {} }; } },
  withTransaction: async (_knex: unknown, callback: (trx: object) => unknown) => callback({}),
  tenantDb: () => ({ table: (name: string) => {
    let calendarId: string | undefined;
    let calendarIds: string[] = [];
    const query: any = {
      where: (cond: Record<string, unknown>) => { calendarId = cond?.calendar_id as string | undefined; return query; },
      whereIn: (_column: string, ids: string[]) => { calendarIds = ids; return query; },
      select: () => query,
      orderBy: async () => calendarIds.map((id) => state.calendars[id]).filter(Boolean),
      first: async () => {
        if (name === 'calendars') return calendarId ? state.calendars[calendarId] : undefined;
        return { ...state.entry };
      },
      pluck: async () => (name === 'schedule_entry_assignees' ? state.assignees : []),
      update: async (patch: Record<string, unknown>) => { state.update(patch); Object.assign(state.entry, patch); return 1; },
    };
    return query;
  } }),
}));
vi.mock('@alga-psa/shared/models/scheduleEntry', () => ({
  default: { create: async (...args: unknown[]) => { state.create(...args); return { entry_id: 'new-entry' }; } },
  validateAllDayInterval: () => undefined,
}));
vi.mock('@alga-psa/scheduling/lib/calendarAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alga-psa/scheduling/lib/calendarAccess')>()),
  resolveCalendarAccess: vi.fn(async () => state.access),
}));
vi.mock('@alga-psa/event-bus/publishers', () => ({ publishEvent: vi.fn(async () => undefined), publishWorkflowEvent: state.publish, publishNonCatalogWorkflowEvent: vi.fn(async () => undefined), publishStoredWorkflowEvent: vi.fn(async () => undefined), publishBuiltWorkflowPayload: vi.fn(async () => undefined), publishNonCatalogEventByName: vi.fn(async () => undefined), publishUnregisteredEventType: vi.fn(async () => undefined) }));
vi.mock('server/src/lib/eventBus/publishers', () => ({ publishEvent: vi.fn(async () => undefined), publishWorkflowEvent: vi.fn(async () => undefined), publishNonCatalogWorkflowEvent: vi.fn(async () => undefined), publishStoredWorkflowEvent: vi.fn(async () => undefined), publishBuiltWorkflowPayload: vi.fn(async () => undefined), publishNonCatalogEventByName: vi.fn(async () => undefined), publishUnregisteredEventType: vi.fn(async () => undefined) }));
vi.mock('@alga-psa/scheduling/models/timePeriod', () => ({ TimePeriod: {} }));
vi.mock('../../../lib/auth/rbac', () => ({ hasPermission: vi.fn().mockResolvedValue(false) }));
vi.mock('../../../lib/api/middleware/apiMiddleware', () => ({
  BadRequestError: class BadRequestError extends Error {}, ConflictError: class ConflictError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {}, NotFoundError: class NotFoundError extends Error {},
}));

import { TimeSheetService } from '../../../lib/api/services/TimeSheetService';
import { BadRequestError, ForbiddenError } from '../../../lib/api/middleware/apiMiddleware';

const context = { tenant: 'tenant', userId: 'owner', user: { user_id: 'owner' } } as any;

function accessWith(groups: Record<string, 'free_busy' | 'read' | 'edit' | 'manage'>) {
  return {
    viewerUserId: 'owner',
    canViewAll: false,
    userLevels: new Map(),
    groupLevels: new Map(Object.entries(groups).map(([calendarId, level]) => [calendarId, { calendarId, level, isArchived: false }])),
    hiddenCalendarIds: [],
  };
}

function service() {
  const svc = new TimeSheetService();
  vi.spyOn(svc, 'getScheduleEntry').mockImplementation(async () => ({ ...state.entry }));
  return svc;
}

const createBody = (patch: Record<string, unknown> = {}) => ({
  title: 'Site visit',
  scheduled_start: '2031-03-03T10:00:00Z',
  scheduled_end: '2031-03-03T11:00:00Z',
  assigned_user_ids: ['owner'],
  is_private: true,
  ...patch,
}) as any;

describe('schedule API group calendar placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.entry = { entry_id: 'entry', tenant: 'tenant', created_by: 'owner', is_private: true, is_all_day: false,
      calendar_id: null, scheduled_start: new Date('2031-03-03T10:00:00Z'), scheduled_end: new Date('2031-03-03T11:00:00Z') };
    state.assignees = ['owner'];
    state.calendars = {
      editable: { calendar_id: 'editable', calendar_type: 'group', is_archived: false, name: 'Field', color: null },
      readonly: { calendar_id: 'readonly', calendar_type: 'group', is_archived: false, name: 'Ops', color: '#111111' },
      archived: { calendar_id: 'archived', calendar_type: 'group', is_archived: true, name: 'Old', color: null },
    };
    state.access = accessWith({ editable: 'edit', readonly: 'read', archived: 'manage' });
  });

  it('creates an entry on an editable group calendar and forces it non-private', async () => {
    await service().createScheduleEntry(createBody({ calendar_id: 'editable' }), context);
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.create.mock.calls[0][2]).toMatchObject({ calendar_id: 'editable', is_private: false });
  });

  it('refuses to create on a read-only or archived calendar', async () => {
    await expect(service().createScheduleEntry(createBody({ calendar_id: 'readonly' }), context))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(service().createScheduleEntry(createBody({ calendar_id: 'archived' }), context))
      .rejects.toBeInstanceOf(BadRequestError);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('keeps create behavior unchanged without calendar_id', async () => {
    await service().createScheduleEntry(createBody(), context);
    expect(state.create.mock.calls[0][2]).toMatchObject({ calendar_id: null, is_private: true });
  });

  it('moves a personal entry onto an editable group calendar and makes it non-private', async () => {
    await service().updateScheduleEntry('entry', { calendar_id: 'editable' } as any, context);
    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ calendar_id: 'editable', is_private: false }));
  });

  it('refuses a move onto a calendar the caller cannot edit and leaves the entry unchanged', async () => {
    await expect(service().updateScheduleEntry('entry', { calendar_id: 'readonly' } as any, context))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(state.update).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('refuses to move an entry off a group calendar the caller cannot edit', async () => {
    Object.assign(state.entry, { calendar_id: 'readonly', is_private: false });
    await expect(service().updateScheduleEntry('entry', { calendar_id: 'editable' } as any, context))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(service().updateScheduleEntry('entry', { calendar_id: null } as any, context))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(state.update).not.toHaveBeenCalled();
  });

  it('moves a group entry back to personal with calendar_id null', async () => {
    Object.assign(state.entry, { calendar_id: 'editable', is_private: false });
    await service().updateScheduleEntry('entry', { calendar_id: null } as any, context);
    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ calendar_id: null }));
    expect(state.update.mock.calls[0][0]).not.toHaveProperty('is_private');
  });

  it('keeps update behavior unchanged without calendar_id', async () => {
    await service().updateScheduleEntry('entry', { title: 'Renamed' } as any, context);
    const patch = state.update.mock.calls[0][0];
    expect(patch).toMatchObject({ title: 'Renamed' });
    expect(patch).not.toHaveProperty('calendar_id');
    expect(patch).not.toHaveProperty('is_private');
  });

  it('still refuses to edit someone else\'s private personal entry', async () => {
    Object.assign(state.entry, { created_by: 'someone-else' });
    state.assignees = ['someone-else'];
    await expect(service().updateScheduleEntry('entry', { calendar_id: 'editable' } as any, context))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(state.update).not.toHaveBeenCalled();
  });

  it('lists only the group calendars visible to the caller, with their access level', async () => {
    state.access = accessWith({ editable: 'edit', readonly: 'read' });
    const calendars = await service().getVisibleGroupCalendars(context);
    expect(calendars).toEqual([
      { calendar_id: 'editable', name: 'Field', description: null, color: '#6366f1', is_archived: false, access_level: 'edit' },
      { calendar_id: 'readonly', name: 'Ops', description: null, color: '#111111', is_archived: false, access_level: 'read' },
    ]);
  });

  it('refuses to move an unassigned group entry back to personal', async () => {
    Object.assign(state.entry, { calendar_id: 'editable', is_private: false });
    state.assignees = [];
    await expect(service().updateScheduleEntry('entry', { calendar_id: null } as any, context))
      .rejects.toBeInstanceOf(BadRequestError);
    expect(state.update).not.toHaveBeenCalled();
  });

  it('reports assignees on both sides of the update event so calendar sync can act on it', async () => {
    await service().updateScheduleEntry('entry', { calendar_id: 'editable' } as any, context);
    const changes = state.publish.mock.calls[0][0].payload.changes;
    expect(changes.before.assignedUserIds).toEqual(['owner']);
    expect(changes.after).toMatchObject({ assignedUserIds: ['owner'], calendar_id: 'editable', is_private: false });
  });
});
