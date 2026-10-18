/**
 * Schedule Calendars API Route
 * GET /api/v1/schedules/calendars - List group calendars visible to the caller
 */

import { ApiTimeSheetController } from 'server/src/lib/api/controllers/ApiTimeSheetController';
import { handleApiError } from 'server/src/lib/api/middleware/apiMiddleware';

export async function GET(request: Request) {
  try {
    const controller = new ApiTimeSheetController();
    return await controller.listScheduleCalendars()(request as any);
  } catch (error) {
    return handleApiError(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
