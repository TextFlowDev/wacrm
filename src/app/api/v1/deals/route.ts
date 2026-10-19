// ============================================================
// GET  /api/v1/deals — list deals, filterable          (deals:read)
// POST /api/v1/deals — create a deal in a stage       (deals:write)
//
// Filters: ?pipeline_id= ?stage_id= ?status= ?contact_id=
// Keyset-paginated like every other v1 list. Every read and write is
// scoped by ctx.accountId, and create verifies that the pipeline, stage
// and contact all belong to the same account before inserting.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage, isUuid } from '@/lib/api/v1/pagination';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';

const DEAL_SELECT =
  'id, pipeline_id, stage_id, contact_id, conversation_id, title, value, currency, notes, expected_close_date, status, created_at, updated_at';

const DEAL_STATUSES = new Set(['active', 'won', 'lost']);

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);

    for (const key of ['pipeline_id', 'stage_id', 'contact_id']) {
      const value = url.searchParams.get(key);
      if (value && !isUuid(value)) {
        return fail('bad_request', `'${key}' must be a UUID`, 400);
      }
    }
    const status = url.searchParams.get('status');
    if (status && !DEAL_STATUSES.has(status)) {
      return fail('bad_request', "'status' must be active, won or lost", 400);
    }

    let query = ctx.supabase
      .from('deals')
      .select(DEAL_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    for (const key of ['pipeline_id', 'stage_id', 'contact_id', 'status']) {
      const value = url.searchParams.get(key);
      if (value) query = query.eq(key, value);
    }

    const keyset = keysetFilter(cursor);
    if (keyset) query = query.or(keyset);

    const { data, error } = await query;
    if (error) return fail('internal_error', 'Could not list deals', 500);

    const page = buildPage((data ?? []) as never[], limit);
    return okList(page.items, page.nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const pipelineId = typeof body.pipeline_id === 'string' ? body.pipeline_id : '';
    const stageId = typeof body.stage_id === 'string' ? body.stage_id : '';
    const contactId = typeof body.contact_id === 'string' ? body.contact_id : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';

    if (!isUuid(pipelineId) || !isUuid(stageId) || !isUuid(contactId)) {
      return fail('bad_request', "'pipeline_id', 'stage_id' and 'contact_id' must be UUIDs", 400);
    }
    if (!title) return fail('bad_request', "'title' is required", 400);

    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : null;
    if (conversationId && !isUuid(conversationId)) {
      return fail('bad_request', "'conversation_id' must be a UUID", 400);
    }

    const value = body.value === undefined ? 0 : Number(body.value);
    if (!Number.isFinite(value) || value < 0 || value > 999_999_999) {
      return fail('bad_request', "'value' must be a non-negative number", 400);
    }

    const currency = typeof body.currency === 'string' ? body.currency.toUpperCase() : 'MYR';
    if (!/^[A-Z]{3}$/.test(currency)) {
      return fail('bad_request', "'currency' must be a three-letter code", 400);
    }

    const expectedCloseDate = typeof body.expected_close_date === 'string' ? body.expected_close_date : null;
    if (expectedCloseDate && !/^\d{4}-\d{2}-\d{2}$/.test(expectedCloseDate)) {
      return fail('bad_request', "'expected_close_date' must be YYYY-MM-DD", 400);
    }

    // Cross-checks: the parent rows must belong to this key's account.
    const { data: pipeline } = await ctx.supabase
      .from('pipelines')
      .select('id')
      .eq('id', pipelineId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!pipeline) return fail('not_found', 'Pipeline not found for this account', 404);

    const { data: stage } = await ctx.supabase
      .from('pipeline_stages')
      .select('id')
      .eq('id', stageId)
      .eq('pipeline_id', pipelineId)
      .maybeSingle();
    if (!stage) return fail('not_found', 'Stage not found in this pipeline', 404);

    const { data: contact } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!contact) return fail('not_found', 'Contact not found for this account', 404);

    const ownerId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
    if (!ownerId) return fail('internal_error', 'Account has no owner user to anchor the deal', 500);

    const { data: deal, error } = await ctx.supabase
      .from('deals')
      .insert({
        account_id: ctx.accountId,
        user_id: ownerId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        contact_id: contactId,
        conversation_id: conversationId,
        title: title.slice(0, 200),
        value,
        currency,
        notes: typeof body.notes === 'string' ? body.notes : null,
        expected_close_date: expectedCloseDate,
        status: 'active',
      })
      .select(DEAL_SELECT)
      .single();

    if (error || !deal) return fail('internal_error', 'Could not create deal', 500);
    return ok(deal, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
