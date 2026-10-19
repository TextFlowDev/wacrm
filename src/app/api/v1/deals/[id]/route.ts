// ============================================================
// GET   /api/v1/deals/:id — read one deal     (deals:read)
// PATCH /api/v1/deals/:id — move/edit a deal  (deals:write)
//
// Moves are stage-to-stage inside the same pipeline; closing a deal sets
// status to won/lost. Account scope is checked on every request, so a
// key from another account gets a 404 rather than a 403 that would
// confirm the row exists.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';

const DEAL_SELECT =
  'id, pipeline_id, stage_id, contact_id, conversation_id, title, value, currency, notes, expected_close_date, status, created_at, updated_at';

const DEAL_STATUSES = new Set(['active', 'won', 'lost']);

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const { id } = await params;
    if (!isUuid(id)) return fail('bad_request', "'id' must be a UUID", 400);

    const { data } = await ctx.supabase
      .from('deals')
      .select(DEAL_SELECT)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (!data) return fail('not_found', 'Deal not found', 404);
    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');
    const { id } = await params;
    if (!isUuid(id)) return fail('bad_request', "'id' must be a UUID", 400);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const { data: existing } = await ctx.supabase
      .from('deals')
      .select('id, pipeline_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!existing) return fail('not_found', 'Deal not found', 404);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.stage_id !== undefined) {
      const stageId = typeof body.stage_id === 'string' ? body.stage_id : '';
      if (!isUuid(stageId)) return fail('bad_request', "'stage_id' must be a UUID", 400);
      const { data: stage } = await ctx.supabase
        .from('pipeline_stages')
        .select('id')
        .eq('id', stageId)
        .eq('pipeline_id', existing.pipeline_id)
        .maybeSingle();
      if (!stage) return fail('not_found', 'Stage not found in this deal’s pipeline', 404);
      patch.stage_id = stageId;
    }

    if (body.status !== undefined) {
      const status = typeof body.status === 'string' ? body.status : '';
      if (!DEAL_STATUSES.has(status)) {
        return fail('bad_request', "'status' must be active, won or lost", 400);
      }
      patch.status = status;
    }

    if (body.value !== undefined) {
      const value = Number(body.value);
      if (!Number.isFinite(value) || value < 0 || value > 999_999_999) {
        return fail('bad_request', "'value' must be a non-negative number", 400);
      }
      patch.value = value;
    }

    if (body.title !== undefined) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) return fail('bad_request', "'title' cannot be empty", 400);
      patch.title = title.slice(0, 200);
    }

    if (body.notes !== undefined) {
      patch.notes = typeof body.notes === 'string' ? body.notes : null;
    }

    if (body.expected_close_date !== undefined) {
      const date = body.expected_close_date;
      if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
        return fail('bad_request', "'expected_close_date' must be YYYY-MM-DD or null", 400);
      }
      patch.expected_close_date = date;
    }

    if (Object.keys(patch).length === 1) {
      return fail('bad_request', 'No editable field supplied', 400);
    }

    const { data, error } = await ctx.supabase
      .from('deals')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(DEAL_SELECT)
      .single();

    if (error || !data) return fail('internal_error', 'Could not update deal', 500);
    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
