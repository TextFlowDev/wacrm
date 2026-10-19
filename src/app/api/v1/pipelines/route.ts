// ============================================================
// GET  /api/v1/pipelines — list pipelines with their stages (pipelines:read)
// POST /api/v1/pipelines — create a pipeline + stages   (pipelines:write)
//
// The dashboard has always had pipelines, but the public API and MCP
// server never exposed them. Every query is scoped by ctx.accountId;
// the API key pins the account, so a key can never see another account's
// board even though the service-role client bypasses RLS.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage, isUuid } from '@/lib/api/v1/pagination';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';

const PIPELINE_SELECT = 'id, name, created_at, pipeline_stages(id, name, position, color, created_at)';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'pipelines:read');
    const { limit, cursor } = parseListParams(request);

    let query = ctx.supabase
      .from('pipelines')
      .select(PIPELINE_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const keyset = keysetFilter(cursor);
    if (keyset) query = query.or(keyset);

    const { data, error } = await query;
    if (error) return fail('internal_error', 'Could not list pipelines', 500);

    const page = buildPage((data ?? []) as never[], limit);
    return okList(page.items, page.nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'pipelines:write');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('bad_request', "'name' is required", 400);

    const stages = Array.isArray(body.stages) ? body.stages : [];
    if (stages.length > 50) {
      return fail('bad_request', 'At most 50 stages per pipeline', 400);
    }
    for (const stage of stages) {
      if (!stage || typeof stage !== 'object' || typeof (stage as { name?: unknown }).name !== 'string') {
        return fail('bad_request', 'Each stage requires a name', 400);
      }
    }

    const ownerId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
    if (!ownerId) return fail('internal_error', 'Account has no owner user to anchor the pipeline', 500);

    const { data: pipeline, error } = await ctx.supabase
      .from('pipelines')
      .insert({ account_id: ctx.accountId, user_id: ownerId, name })
      .select('id, name, created_at')
      .single();
    if (error || !pipeline) return fail('internal_error', 'Could not create pipeline', 500);

    if (stages.length) {
      const rows = stages.map((stage, index) => {
        const s = stage as { name: string; color?: unknown };
        return {
          pipeline_id: pipeline.id,
          name: s.name.trim().slice(0, 120),
          position: index,
          color: typeof s.color === 'string' ? s.color : '#3b82f6',
        };
      });
      const { error: stageError } = await ctx.supabase.from('pipeline_stages').insert(rows);
      if (stageError) {
        // Leave the empty pipeline in place: deleting it would also delete any
        // deal an operator added between these two statements.
        return fail('internal_error', 'Pipeline created, but stages could not be saved', 500);
      }
    }

    const { data: full } = await ctx.supabase
      .from('pipelines')
      .select(PIPELINE_SELECT)
      .eq('id', pipeline.id)
      .eq('account_id', ctx.accountId)
      .single();

    return ok(full ?? pipeline, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
