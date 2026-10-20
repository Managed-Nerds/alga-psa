import { describe, expect, it } from 'vitest';
import {
  agentsFromEntities,
  buildEscalationPortalUrl,
  buildEscalationTicketBody,
  buildEscalationTicketTitle,
  buildEscalationUpdateNote,
} from '@ee/lib/integrations/huntress/escalations/escalationContent';
import type { HuntressEscalation } from '@ee/interfaces/huntress.interfaces';

function escalation(overrides: Partial<HuntressEscalation> = {}): HuntressEscalation {
  return {
    id: 84938,
    organizations: [{ id: 10, name: 'Acme' }],
    severity: 'critical',
    status: 'open',
    subject: 'Defender Disabled',
    type: 'Environmental Issue',
    type_code: 'defender_disabled',
    subtype: null,
    created_at: '2026-06-09T10:00:00Z',
    resolved_at: null,
    updated_at: '2026-06-09T10:00:00Z',
    ...overrides,
  };
}

describe('escalation ticket content', () => {
  it('builds the account escalation portal URL', () => {
    expect(buildEscalationPortalUrl('managednerds', 84938)).toBe(
      'https://managednerds.huntress.io/account/escalations/84938'
    );
  });

  it('prefixes titles and flags unmapped orgs', () => {
    expect(buildEscalationTicketTitle(escalation(), { unmapped: false })).toBe(
      '[Huntress Escalation] Defender Disabled'
    );
    expect(buildEscalationTicketTitle(escalation({ subject: null }), { unmapped: true })).toBe(
      '[Huntress Escalation] [Unmapped Org] Environmental Issue'
    );
  });

  it('extracts Agent entities as agents', () => {
    const agents = agentsFromEntities(
      escalation({
        entities: {
          total_count: 2,
          has_more: false,
          items: [
            { id: 1, type: 'Agent', details: { hostname: 'laptop01', os: 'Windows 11' } },
            { id: 2, type: 'Identity', details: { email: 'a@acme.test' } },
          ],
        },
      })
    );
    expect(agents).toEqual([
      { id: 1, hostname: 'laptop01', os: 'Windows 11', platform: null, last_callback_at: null },
    ]);
  });

  it('lists every organization on a multi-org escalation', () => {
    const body = buildEscalationTicketBody(
      escalation({ organizations: [{ id: 10, name: 'Acme' }, { id: 11, name: 'Globex' }] }),
      'https://x',
      { unmapped: false, organization: { id: 11, name: 'Globex' }, agent: null }
    );
    expect(body).toContain('**Huntress Organization:** Globex');
    expect(body).toContain('covers 2 organizations');
    expect(body).toContain('- Acme');
    expect(body).toContain('[View in Huntress portal](https://x)');
  });

  it('survives malformed entity/organization payloads', () => {
    expect(() =>
      buildEscalationTicketBody(
        escalation({ organizations: {} as any, entities: { items: 'bad' } as any }),
        'https://x',
        { unmapped: true, organization: null, agent: null }
      )
    ).not.toThrow();
  });

  it('calls out a newly overdue escalation once', () => {
    expect(buildEscalationUpdateNote('open', escalation({ status: 'overdue' }))).toContain(
      'overdue'
    );
    expect(
      buildEscalationUpdateNote('overdue', escalation({ status: 'overdue' }))
    ).not.toContain('past its expected response time');
  });
});
