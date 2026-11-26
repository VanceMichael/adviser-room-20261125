import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findById, requireRole, resolveDocument, activeMembership, memberConflictState,
  effectiveNda, deliveryProgress, authorizeDocument
} from './store.mjs';
import {
  sendJson, sendError, readJson, serveAuthorizedDocument, segmentList, hashBuffer
} from './http-utils.mjs';
import {
  secretaryEngagementView, clientEngagementView, adviserEngagementView, adviserInquiryView
} from './serializers.mjs';
import { summarizeSignerStatus } from './signing.mjs';

const PURPOSES = ['quote', 'perform'];

function badRequest(code, error, status = 400) {
  return { error: { status, body: { code, error } } };
}

function engagementForActor(state, id, actor) {
  const engagement = findById(state.engagements, id);
  if (!engagement) return { error: { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND', error: '事项不存在' } } };
  if (actor.role === 'secretariat') return { engagement };
  if (actor.role === 'client') {
    if (engagement.client !== actor.organization) {
      return { error: { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND', error: '事项不存在' } } };
    }
    return { engagement };
  }
  if (actor.role === 'counterparty') {
    if (!(engagement.counterparties || []).includes(actor.organization)) {
      return { error: { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND', error: '事项不存在' } } };
    }
    return { engagement };
  }
  const view = adviserEngagementView(state, engagement, actor);
  if (!view) return { error: { status: 404, body: { code: 'ENGAGEMENT_NOT_FOUND', error: '事项不存在' } } };
  return { engagement, adviserView: view };
}

function screeningViewForActor(state, screening, actor) {
  if (actor.role === 'secretariat' || actor.role === 'client') return screening;
  if (actor.role === 'adviser' && screening.firmId === actor.firm) {
    return {
      id: screening.id,
      engagementId: screening.engagementId,
      firmId: screening.firmId,
      status: screening.status,
      members: screening.members.map(m => ({
        memberId: m.memberId,
        reviewRequired: m.check === 'manual_review_required',
        actionRequired: !!memberConflictState(state, screening.engagementId, m.memberId).blocking
      })),
      decline: screening.decline ? { retainedBasis: screening.decline.limitedBasis } : null
    };
  }
  return null;
}

async function createDisclosureGrants(ctx, engagement, payload, draftId = null) {
  const { store, actor } = ctx;
  const state = store.state;
  const firmId = payload.firmId;
  const memberIds = [...new Set(payload.memberIds ?? [])];
  if (!firmId || !findById(state.organizations, firmId)) return badRequest('FIRM_REQUIRED', '必须指定受托顾问机构');
  if (!memberIds.length) return badRequest('MEMBERS_REQUIRED', '必须指定实际可见资料的人员；机构筛查不自动覆盖后来成员');

  for (const memberId of memberIds) {
    const member = findById(state.members, memberId);
    if (!member || member.firm !== firmId) return badRequest('MEMBER_FIRM_MISMATCH', `人员 ${memberId} 不属于该机构`, 409);
    if (!activeMembership(state, engagement.id, memberId)) return badRequest('MEMBER_NOT_ON_ENGAGEMENT', `人员 ${memberId} 不是事项当前成员`, 409);
    const conflict = memberConflictState(state, engagement.id, memberId);
    if (conflict.blocking) return badRequest('CONFLICT_NOT_CLEARED', `人员 ${memberId} 尚不能披露：冲突未清除或未完成双方豁免`, 409);
    if (!effectiveNda(state, engagement.id, memberId, firmId)) return badRequest('NDA_NOT_EFFECTIVE', `人员 ${memberId} 的保密承诺尚未终态生效`, 409);
  }

  let items = payload.items ?? payload.documents ?? null;
  if (!items && payload.documentId) items = [{ documentId: payload.documentId, version: payload.version, sections: payload.sections, purposes: payload.purposes }];
  if (!Array.isArray(items) || !items.length) return badRequest('DOCUMENT_SCOPE_REQUIRED', '必须按文件版本、章节和用途给出授权范围');

  const normalized = [];
  for (const item of items) {
    const doc = resolveDocument(state, item.documentId, item.version);
    if (!doc || doc.owner !== engagement.client) return badRequest('DOCUMENT_NOT_FOUND', '文件版本不存在或不属于该企业', 404);
    const sections = [...new Set(item.sections ?? [])];
    const purposes = [...new Set(item.purposes ?? payload.purposes ?? ['quote'])];
    if (!sections.length || sections.some(s => !doc.sections.includes(s))) return badRequest('INVALID_SECTIONS', `文件 ${doc.id} 的章节不合法`);
    if (!purposes.length || purposes.some(p => !PURPOSES.includes(p))) return badRequest('INVALID_PURPOSES', '用途仅支持 quote（报价阅读）或 perform（受托工作）');
    normalized.push({ doc, sections, purposes, allowSubcontracting: !!(item.allowSubcontracting ?? payload.allowSubcontracting) });
  }

  const disclosureId = store.nextId('DISC');
  const disclosure = {
    id: disclosureId,
    engagementId: engagement.id,
    clientOrgId: engagement.client,
    firmId,
    memberIds,
    draftId,
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: actor.id,
    idempotencyKey: payload.idempotencyKey ?? null
  };
  state.disclosures.push(disclosure);
  const grants = [];
  for (const item of normalized) {
    const grant = {
      id: store.nextId('GRANT'),
      disclosureId,
      engagementId: engagement.id,
      clientOrgId: engagement.client,
      firmId,
      memberIds,
      documentId: item.doc.id,
      familyId: item.doc.familyId,
      version: item.doc.version,
      sha256: item.doc.sha256,
      sections: item.sections,
      purposes: item.purposes,
      allowSubcontracting: item.allowSubcontracting,
      status: 'active',
      createdAt: new Date().toISOString(),
      revokedAt: null
    };
    state.grants.push(grant);
    grants.push(grant);
  }
  if (!['in_delivery', 'handoff', 'completed', 'closed'].includes(engagement.status)) {
    engagement.status = 'disclosed';
    engagement.stage = 'disclosed';
  }
  store.audit(actor, 'disclosure.created', { engagementId: engagement.id, disclosureId, grantIds: grants.map(g => g.id), draftId });
  return { value: { disclosure, grants } };
}

async function createWorkProduct(ctx, engagement, body, draft = null) {
  const { store, actor } = ctx;
  const state = store.state;
  const firmId = actor.firm;
  const commission = state.commissions.find(c => c.engagementId === engagement.id && c.firmId === firmId && c.status === 'active' && c.memberIds.includes(actor.member));
  if (!commission) return badRequest('COMMISSION_REQUIRED', '企业确认委托后顾问才能提交受托成果', 409);
  if (!body.title && !draft?.id) return badRequest('TITLE_REQUIRED', '成果必须有标题');
  const content = body.content ?? `合成工作成果：${body.title ?? draft.id}\n`;
  const buffer = Buffer.from(content, 'utf8');
  const citationsInput = body.citations ?? (draft?.references ?? []).map(documentId => ({ documentId }));
  const citations = [];
  for (const citation of citationsInput) {
    const citationObj = typeof citation === 'string' ? { documentId: citation } : citation;
    const doc = resolveDocument(state, citationObj.documentId, citationObj.version);
    if (!doc) return badRequest('CITATION_VERSION_NOT_FOUND', `引用资料版本不存在：${citationObj.documentId}`, 404);
    citations.push({ documentId: doc.id, version: doc.version, sha256: doc.sha256, sections: citationObj.sections ?? doc.sections });
  }
  const id = store.nextId('WP');
  const storageKey = `${id}.txt`;
  const fullPath = join(ctx.config.localObjectDir, storageKey);
  writeFileSync(fullPath, buffer);
  const transfer = body.transfer ?? (draft?.transfer === 'client-approval'
    ? { successorTransfer: 'client-approval', requiresClientApproval: true, requiresOriginConsent: false }
    : { successorTransfer: 'restricted-case-by-case', requiresClientApproval: true, requiresOriginConsent: true });
  const wp = {
    id,
    engagementId: engagement.id,
    originFirmId: firmId,
    authorMemberId: actor.member,
    draftId: draft?.id ?? null,
    title: body.title ?? `依据 ${draft?.id} 提交的合成成果`,
    summary: body.summary ?? '',
    storage: 'local',
    storageKey,
    sizeBytes: buffer.length,
    sha256: hashBuffer(buffer),
    citations,
    transfer,
    status: 'submitted',
    review: null,
    createdAt: new Date().toISOString()
  };
  state.workProducts.push(wp);
  store.audit(actor, 'work_product.submitted', { engagementId: engagement.id, workProductId: id, citations });
  return { value: wp, status: 201 };
}

function authorizeWorkContent(state, actor, wp) {
  if (actor.role === 'secretariat' || actor.role === 'client' && actor.organization === findById(state.engagements, wp.engagementId)?.client) return { ok: true };
  if (actor.role !== 'adviser') return { ok: false, status: 403, code: 'FORBIDDEN' };
  if (wp.originFirmId === actor.firm) {
    if (!activeMembership(state, wp.engagementId, actor.member)) return { ok: false, status: 403, code: 'TEAM_MEMBER_INACTIVE', error: '成员已更换，后续成果访问按当前授权拒绝' };
    return { ok: true };
  }
  const eligibleNda = effectiveNda(state, wp.engagementId, actor.member, actor.firm);
  const conflict = memberConflictState(state, wp.engagementId, actor.member);
  const membership = activeMembership(state, wp.engagementId, actor.member);
  if (!membership || conflict.blocking || !eligibleNda) return { ok: false, status: 403, code: 'SUCCESSOR_NOT_ELIGIBLE', error: '接任顾问尚未满足成员、筛查或生效保密承诺条件' };
  const entitled = state.handoffs.some(h =>
    h.engagementId === wp.engagementId && h.toFirmId === actor.firm && h.memberIds.includes(actor.member) &&
    h.items.some(i => i.kind === 'workProduct' && i.workProductId === wp.id &&
      i.clientApproved === true &&
      (!wp.transfer?.requiresOriginConsent || i.originReleased === true) &&
      i.status !== 'excluded')
  );
  if (!entitled) return { ok: false, status: 403, code: 'WORK_TRANSFER_NOT_AUTHORIZED', error: '交接清单本身不是逐项成果转交授权' };
  return { ok: true };
}

export async function handleApi(ctx) {
  const { req, res, url, pathname, query, body, store, config, signing } = ctx;
  const state = store.state;
  const actor = ctx.actor ?? null;
  let m;

  if (pathname === '/api' && req.method === 'GET') {
    return sendJson(res, 200, {
      service: 'adviser-room',
      syntheticOnly: true,
      roles: ['client', 'secretary', 'adviser-a', 'adviser-b', 'adviser-c', 'adviser-successor', 'counterparty-b'],
      groups: ['/api/engagements', '/api/secretary/engagements', '/api/client/engagements', '/api/adviser/engagements', '/api/adviser/inquiries']
    });
  }

  if (pathname === '/api/source-changes' && req.method === 'GET') {
    if (!requireRole(actor, 'secretariat')) return sendJson(res, 403, { code: 'SECRETARY_ONLY' });
    return sendJson(res, 200, {
      sourceChanges: state.fixtureDrafts.sourceChanges,
      warning: '这些只是未自动导入的来源申请/观察；必须通过团队、豁免、披露撤权或交接操作形成业务决定。'
    });
  }

  if (pathname === '/api/consent-drafts' && req.method === 'GET') {
    if (!requireRole(actor, 'client', 'secretariat')) return sendJson(res, 403, { code: 'CLIENT_OR_SECRETARY_ONLY' });
    return sendJson(res, 200, { consentDrafts: state.fixtureDrafts.consentDrafts, warning: '草稿不是生效授权，必须由企业调用 approve。' });
  }

  if (pathname === '/api/dev/state-summary' && req.method === 'GET') {
    if (actor?.role !== 'secretariat') return sendJson(res, 403, { code: 'SECRETARY_ONLY' });
    return sendJson(res, 200, {
      counts: Object.fromEntries(['engagements', 'inquiries', 'screenings', 'ndas', 'grants', 'workProducts', 'handoffs', 'accessEvents', 'auditEvents'].map(k => [k, state[k].length]))
    });
  }

  if (pathname === '/api/engagements' && req.method === 'GET') {
    if (actor.role === 'secretariat') return sendJson(res, 200, { engagements: state.engagements.map(e => secretaryEngagementView(state, e)) });
    if (actor.role === 'client') {
      return sendJson(res, 200, { engagements: state.engagements.filter(e => e.client === actor.organization).map(e => clientEngagementView(state, e, actor)) });
    }
    if (actor.role === 'adviser') {
      return sendJson(res, 200, { engagements: state.engagements.map(e => adviserEngagementView(state, e, actor)).filter(Boolean) });
    }
    return sendJson(res, 403, { code: 'ROLE_NOT_ALLOWED' });
  }

  if (pathname === '/api/secretary/conflict-index' && req.method === 'GET') {
    if (!requireRole(actor, 'secretariat')) return sendJson(res, 403, { code: 'SECRETARY_ONLY' });
    return sendJson(res, 200, { mappings: state.secretMappings, otherMatters: state.secretOtherMatters, warning: '仅秘书处可见；顾问接口只返回是否需要人工核查' });
  }
  if (pathname === '/api/secretary/engagements' && req.method === 'GET') {
    if (!requireRole(actor, 'secretariat')) return sendJson(res, 403, { code: 'SECRETARY_ONLY' });
    return sendJson(res, 200, { engagements: state.engagements.map(e => secretaryEngagementView(state, e)) });
  }
  if (pathname === '/api/client/engagements' && req.method === 'GET') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY' });
    return sendJson(res, 200, { engagements: state.engagements.filter(e => e.client === actor.organization).map(e => clientEngagementView(state, e, actor)) });
  }
  if (pathname === '/api/adviser/engagements' && req.method === 'GET') {
    if (!requireRole(actor, 'adviser')) return sendJson(res, 403, { code: 'ADVISER_ONLY' });
    return sendJson(res, 200, { engagements: state.engagements.map(e => adviserEngagementView(state, e, actor)).filter(Boolean) });
  }
  if (pathname === '/api/adviser/inquiries' && req.method === 'GET') {
    if (!requireRole(actor, 'adviser')) return sendJson(res, 403, { code: 'ADVISER_ONLY' });
    const rows = state.inquiries.filter(i => i.firmId === actor.firm).map(i => adviserInquiryView(state, i, actor));
    return sendJson(res, 200, { inquiries: rows });
  }

  if (pathname === '/api/engagements' && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY', error: '咨询事项由企业提交' });
    const counterparties = body.counterparties ?? body.partyIds?.counterparties ?? [];
    const relatedParties = body.relatedParties ?? body.partyIds?.relatedParties ?? [];
    const areas = body.areas ?? [];
    if (!Array.isArray(counterparties) || !Array.isArray(relatedParties) || !Array.isArray(areas) || !areas.length) {
      return sendJson(res, 400, { code: 'INVALID_ENGAGEMENT', error: '必须提供对手方、关联主体数组及至少一个专业领域' });
    }
    const id = body.id ?? store.nextId('ENG');
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(id) || findById(state.engagements, id)) {
      return sendJson(res, 409, { code: 'ENGAGEMENT_ID_INVALID_OR_EXISTS' });
    }
    const engagement = {
      id,
      title: body.title ?? '合成咨询事项',
      client: actor.organization,
      counterparties,
      relatedParties,
      areas,
      materialScope: body.materialScope ?? [],
      status: 'submitted',
      stage: 'submitted',
      createdBy: actor.id,
      createdAt: new Date().toISOString()
    };
    await store.commit(() => {
      state.engagements.push(engagement);
      store.audit(actor, 'engagement.submitted', { engagementId: id, areas, materialScope: engagement.materialScope });
    });
    return sendJson(res, 201, { engagement: clientEngagementView(state, engagement, actor) });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)$/))) {
    const found = engagementForActor(state, decodeURIComponent(m[1]), actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    if (req.method === 'GET') {
      if (actor.role === 'secretariat') return sendJson(res, 200, { engagement: secretaryEngagementView(state, found.engagement) });
      if (actor.role === 'client') return sendJson(res, 200, { engagement: clientEngagementView(state, found.engagement, actor) });
      return sendJson(res, 200, { engagement: found.adviserView });
    }
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/inquiries$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'secretariat')) return sendJson(res, 403, { code: 'SECRETARY_ONLY' });
    const found = engagementForActor(state, decodeURIComponent(m[1]), actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    const engagement = found.engagement;
    const firmIds = body.firmIds ?? (body.firmId ? [body.firmId] : []);
    if (!firmIds.length) return sendJson(res, 400, { code: 'FIRMS_REQUIRED' });
    const inquiries = [];
    await store.commit(() => {
      for (const firmId of firmIds) {
        if (!findById(state.organizations, firmId)) continue;
        const inquiry = { id: store.nextId('INQ'), engagementId: engagement.id, firmId, status: 'sent', createdAt: new Date().toISOString(), requiredMembers: body.memberIds ?? null };
        state.inquiries.push(inquiry);
        inquiries.push(inquiry);
      }
      engagement.status = 'screening'; engagement.stage = 'screening';
      store.audit(actor, 'inquiries.sent', { engagementId: engagement.id, firmIds });
    });
    return sendJson(res, 201, { inquiries });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/screenings$/)) && req.method === 'POST') {
    const engagementId = decodeURIComponent(m[1]);
    const found = engagementForActor(state, engagementId, actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    const engagement = found.engagement;
    let firmId;
    let memberIds;
    if (actor.role === 'adviser') {
      firmId = actor.firm;
      memberIds = body.memberIds?.length ? body.memberIds : [actor.member];
    } else if (actor.role === 'secretariat' && body.firmId) {
      firmId = body.firmId; memberIds = body.memberIds ?? [];
    } else return sendJson(res, 403, { code: 'ADVISER_OR_SECRETARY_FIRM_REQUIRED' });
    if (!memberIds.length) return sendJson(res, 400, { code: 'MEMBERS_REQUIRED' });
    const partyIds = [engagement.client, ...engagement.counterparties, ...(engagement.relatedParties || [])];
    const screening = {
      id: store.nextId('SCR'), engagementId, firmId, status: 'clear', source: body.source ?? 'adviser_check',
      createdAt: new Date().toISOString(), members: []
    };
    for (const memberId of memberIds) {
      const member = findById(state.members, memberId);
      if (!member || member.firm !== firmId) return sendJson(res, 409, { code: 'MEMBER_FIRM_MISMATCH' });
      const mappings = state.secretMappings.filter(x => x.memberId === memberId && partyIds.includes(x.organizationId));
      const declaredHits = (member.affiliations || []).filter(orgId => partyIds.includes(orgId));
      const matches = [...mappings.map(x => ({ mappingId: x.id, organizationId: x.organizationId, code: x.code })), ...declaredHits.map(orgId => ({ source: 'declared', organizationId: orgId, code: 'DECLARED_AFFILIATION' }))];
      const uniqueMatches = matches.filter((x, i, arr) => arr.findIndex(y => y.organizationId === x.organizationId && y.code === x.code) === i);
      const check = uniqueMatches.length ? 'manual_review_required' : 'clear';
      screening.members.push({ memberId, check, review: check === 'manual_review_required' ? 'pending' : 'not_required', matches: uniqueMatches, waivers: {} });
      if (check === 'manual_review_required') screening.status = 'manual_review_required';
    }
    await store.commit(() => {
      state.screenings.push(screening);
      engagement.status = 'screening'; engagement.stage = 'screening';
      store.audit(actor, 'screening.created', { screeningId: screening.id, engagementId, status: screening.status });
    });
    return sendJson(res, 201, { screening: screeningViewForActor(state, screening, actor) });
  }

  if ((m = pathname.match(/^\/api\/screenings\/([^/]+)$/)) && req.method === 'GET') {
    const screening = findById(state.screenings, decodeURIComponent(m[1]));
    if (!screening) return sendJson(res, 404, { code: 'SCREENING_NOT_FOUND' });
    const view = screeningViewForActor(state, screening, actor);
    if (!view) return sendJson(res, 404, { code: 'SCREENING_NOT_FOUND' });
    return sendJson(res, 200, { screening: view });
  }

  if ((m = pathname.match(/^\/api\/screenings\/([^/]+)\/review$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'secretariat')) return sendJson(res, 403, { code: 'SECRETARY_ONLY' });
    const screening = findById(state.screenings, decodeURIComponent(m[1]));
    if (!screening) return sendJson(res, 404, { code: 'SCREENING_NOT_FOUND' });
    await store.commit(() => {
      const decisions = body.decisions ?? (body.memberId ? [{ memberId: body.memberId, outcome: body.outcome, notes: body.notes }] : screening.members.filter(x => x.check === 'manual_review_required').map(x => ({ memberId: x.memberId, outcome: body.outcome, notes: body.notes })));
      for (const decision of decisions) {
        const item = screening.members.find(x => x.memberId === decision.memberId);
        if (!item || !['clear', 'conflict_confirmed'].includes(decision.outcome)) continue;
        item.review = decision.outcome;
        item.reviewNotes = decision.notes ?? null;
        item.reviewedAt = new Date().toISOString();
      }
      const engagement = findById(state.engagements, screening.engagementId);
      const anyBlock = screening.members.some(item => memberConflictState(state, screening.engagementId, item.memberId).blocking);
      screening.status = anyBlock ? 'manual_review_required' : 'cleared';
      if (!anyBlock && engagement) { engagement.status = 'signing'; engagement.stage = 'signing'; }
      store.audit(actor, 'screening.reviewed', { screeningId: screening.id, outcome: body.outcome });
    });
    return sendJson(res, 200, { screening });
  }

  if ((m = pathname.match(/^\/api\/screenings\/([^/]+)\/waivers$/)) && req.method === 'POST') {
    const screening = findById(state.screenings, decodeURIComponent(m[1]));
    if (!screening) return sendJson(res, 404, { code: 'SCREENING_NOT_FOUND' });
    const party = body.party;
    if (!['client', 'counterparty'].includes(party) || !body.writingRef) return sendJson(res, 400, { code: 'WAIVER_FORMAT_REQUIRED', error: '必须给出 party 和书面豁免编号 writingRef' });
    if (actor.role === 'client' && (party !== 'client' || actor.organization !== findById(state.engagements, screening.engagementId)?.client)) {
      return sendJson(res, 403, { code: 'CLIENT_PARTY_ONLY' });
    }
    if (actor.role === 'counterparty' && party !== 'counterparty') return sendJson(res, 403, { code: 'COUNTERPARTY_PARTY_ONLY' });
    if (!requireRole(actor, 'client', 'counterparty', 'secretariat')) return sendJson(res, 403, { code: 'WAIVER_ROLE_DENIED' });
    await store.commit(() => {
      const targets = body.memberId ? screening.members.filter(x => x.memberId === body.memberId) : screening.members;
      for (const item of targets) {
        item.waivers ||= {};
        item.waivers[party] = { writingRef: body.writingRef, signedBy: body.signedBy ?? actor.name ?? actor.id, recordedBy: actor.id, sourceChangeId: body.sourceChangeId ?? null, at: new Date().toISOString() };
      }
      const anyBlock = screening.members.some(item => memberConflictState(state, screening.engagementId, item.memberId).blocking);
      screening.status = anyBlock ? 'manual_review_required' : 'waived_or_cleared';
      const engagement = findById(state.engagements, screening.engagementId);
      if (!anyBlock && engagement) { engagement.status = 'signing'; engagement.stage = 'signing'; }
      store.audit(actor, 'waiver.recorded', { screeningId: screening.id, party, writingRef: body.writingRef });
    });
    return sendJson(res, 200, { screening: actor.role === 'adviser' ? screeningViewForActor(state, screening, actor) : screening });
  }

  if ((m = pathname.match(/^\/api\/screenings\/([^/]+)\/decline$/)) && req.method === 'POST') {
    const screening = findById(state.screenings, decodeURIComponent(m[1]));
    if (!screening) return sendJson(res, 404, { code: 'SCREENING_NOT_FOUND' });
    if (actor.role !== 'adviser' || screening.firmId !== actor.firm) return sendJson(res, 403, { code: 'OWN_FIRM_ONLY' });
    const hit = screening.members.some(x => x.check === 'manual_review_required');
    const limitedBasis = {
      code: hit ? 'FURTHER_REVIEW_RESULT_RETAINED' : 'NO_MATCH_RESULT_RETAINED',
      screeningId: screening.id,
      requiresManualReview: hit,
      retainedAt: new Date().toISOString()
    };
    await store.commit(() => {
      screening.status = 'declined';
      screening.decline = { at: new Date().toISOString(), actorId: actor.id, reasonCode: body.reasonCode ?? 'firm_decision', limitedBasis };
      store.audit(actor, 'screening.declined', { screeningId: screening.id, code: limitedBasis.code });
    });
    return sendJson(res, 200, { declined: true, retainedBasis: limitedBasis });
  }

  if (pathname === '/api/conflicts' && req.method === 'POST') {
    const engagement = findById(state.engagements, body.engagementId);
    if (!engagement || !body.memberId || !body.organizationId) return sendJson(res, 400, { code: 'CONFLICT_FACT_REQUIRED' });
    const member = findById(state.members, body.memberId);
    if (actor.role === 'adviser' && (!member || member.firm !== actor.firm)) return sendJson(res, 403, { code: 'OWN_FIRM_MEMBERS_ONLY' });
    if (!requireRole(actor, 'secretariat', 'adviser')) return sendJson(res, 403, { code: 'ROLE_DENIED' });
    let screening;
    await store.commit(() => {
      if (!state.secretMappings.some(x => x.memberId === body.memberId && x.organizationId === body.organizationId)) {
        state.secretMappings.push({ id: store.nextId('SM'), memberId: body.memberId, organizationId: body.organizationId, code: body.code ?? 'NEW_FACT_MATCH', recordedBy: actor.id });
      }
      screening = {
        id: store.nextId('SCR'), engagementId: engagement.id, firmId: member.firm, status: 'manual_review_required',
        source: 'new_conflict_fact', createdAt: new Date().toISOString(),
        members: [{ memberId: body.memberId, check: 'manual_review_required', review: 'conflict_confirmed', matches: [{ organizationId: body.organizationId, code: 'NEW_FACT_MATCH' }], waivers: {} }]
      };
      state.screenings.push(screening);
      store.audit(actor, 'conflict.reported', { engagementId: engagement.id, screeningId: screening.id, memberId: body.memberId });
    });
    return sendJson(res, 201, { screening: screeningViewForActor(state, screening, actor) });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/team$/)) && req.method === 'GET') {
    const found = engagementForActor(state, decodeURIComponent(m[1]), actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    return sendJson(res, 200, { team: state.teamMemberships.filter(t => t.engagementId === found.engagement.id) });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/team-members$/)) && req.method === 'POST') {
    const found = engagementForActor(state, decodeURIComponent(m[1]), actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    const engagement = found.engagement;
    if (!requireRole(actor, 'secretariat', 'adviser')) return sendJson(res, 403, { code: 'SECRETARY_OR_FIRM_ONLY' });
    const firmId = actor.role === 'adviser' ? actor.firm : body.firmId;
    const memberId = body.memberId ?? body.id;
    if (!firmId || !memberId) return sendJson(res, 400, { code: 'FIRM_AND_MEMBER_REQUIRED' });
    let member = findById(state.members, memberId);
    if (actor.role === 'adviser' && member && member.firm !== actor.firm) return sendJson(res, 403, { code: 'OWN_FIRM_ONLY' });
    let actorId = null;
    await store.commit(() => {
      if (!member) {
        member = { id: memberId, firm: firmId, name: body.name ?? `合成成员 ${memberId}`, affiliations: body.affiliations ?? [] };
        state.members.push(member);
        actorId = `actor-${memberId}`;
        state.actors.push({ id: actorId, role: 'adviser', member: memberId, firm: firmId, name: `${member.name}接口` });
      } else if (Array.isArray(body.affiliations)) {
        member.affiliations = [...new Set([...(member.affiliations || []), ...body.affiliations])];
      }
      const existing = activeMembership(state, engagement.id, memberId);
      if (!existing) {
        state.teamMemberships.push({ id: store.nextId('TM'), engagementId: engagement.id, firmId, memberId, status: 'active', reason: body.reason ?? 'team_change', sourceChangeId: body.sourceChangeId ?? null, createdAt: new Date().toISOString(), removedAt: null });
      }
      store.audit(actor, 'team.member_added', { engagementId: engagement.id, memberId, firmId });
    });
    return sendJson(res, 201, { member, actorId, access: { screened: false, ndaEffective: false, disclosed: false }, warning: '加入机构或事项不会自动继承筛查、保密承诺或披露授权' });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/team-members\/([^/]+)\/remove$/)) && req.method === 'POST') {
    const engagementId = decodeURIComponent(m[1]);
    const memberId = decodeURIComponent(m[2]);
    const found = engagementForActor(state, engagementId, actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    if (!requireRole(actor, 'secretariat', 'adviser', 'client')) return sendJson(res, 403, { code: 'ROLE_DENIED' });
    await store.commit(() => {
      for (const tm of state.teamMemberships.filter(t => t.engagementId === engagementId && t.memberId === memberId && t.status === 'active')) {
        tm.status = 'removed'; tm.removedAt = new Date().toISOString(); tm.removeReason = body.reason ?? 'member_replaced_or_removed';
      }
      store.audit(actor, 'team.member_removed', { engagementId, memberId, replacementMemberId: body.replacementMemberId ?? null });
    });
    return sendJson(res, 200, { removed: memberId, futureAccess: 'denied_under_current_authorization', alreadyTransmittedBytes: 'cannot_be_remotely_reclaimed' });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/replace-member$/)) && req.method === 'POST') {
    const engagementId = decodeURIComponent(m[1]);
    const found = engagementForActor(state, engagementId, actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    if (!body.oldMemberId || !body.newMemberId) return sendJson(res, 400, { code: 'OLD_AND_NEW_MEMBER_REQUIRED' });
    const firmId = actor.role === 'adviser' ? actor.firm : (body.firmId || findById(state.members, body.oldMemberId)?.firm);
    let newActorId = null;
    await store.commit(() => {
      for (const tm of state.teamMemberships.filter(t => t.engagementId === engagementId && t.memberId === body.oldMemberId && t.status === 'active')) {
        tm.status = 'replaced'; tm.removedAt = new Date().toISOString(); tm.replacedBy = body.newMemberId;
      }
      let member = findById(state.members, body.newMemberId);
      if (!member) {
        member = { id: body.newMemberId, firm: firmId, name: body.newMemberName ?? `合成成员 ${body.newMemberId}`, affiliations: body.affiliations ?? [] };
        state.members.push(member);
        newActorId = `actor-${body.newMemberId}`;
        state.actors.push({ id: newActorId, role: 'adviser', member: body.newMemberId, firm: firmId });
      }
      if (!activeMembership(state, engagementId, body.newMemberId)) {
        state.teamMemberships.push({ id: store.nextId('TM'), engagementId, firmId: member.firm, memberId: body.newMemberId, status: 'active', reason: 'replacement', createdAt: new Date().toISOString() });
      }
      store.audit(actor, 'team.member_replaced', { engagementId, oldMemberId: body.oldMemberId, newMemberId: body.newMemberId });
    });
    return sendJson(res, 200, { oldMemberId: body.oldMemberId, newMemberId: body.newMemberId, newActorId, newMemberAccess: 'blocked_until_screening_nda_and_client_scope', futureOldAccess: 'denied' });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/ndas$/)) && req.method === 'POST') {
    const engagementId = decodeURIComponent(m[1]);
    const found = engagementForActor(state, engagementId, actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    const engagement = found.engagement;
    if (!requireRole(actor, 'adviser', 'secretariat')) return sendJson(res, 403, { code: 'ADVISER_ONLY' });
    const firmId = actor.role === 'adviser' ? actor.firm : body.firmId;
    const memberIds = body.memberIds?.length ? body.memberIds : (actor.member ? [actor.member] : []);
    if (!firmId || !memberIds.length) return sendJson(res, 400, { code: 'FIRM_AND_MEMBERS_REQUIRED' });
    for (const memberId of memberIds) {
      const member = findById(state.members, memberId);
      if (!member || member.firm !== firmId) return sendJson(res, 409, { code: 'MEMBER_FIRM_MISMATCH' });
      if (!activeMembership(state, engagementId, memberId)) return sendJson(res, 409, { code: 'MEMBER_NOT_ON_ENGAGEMENT' });
      const hasScreening = state.screenings.some(s => s.engagementId === engagementId && s.firmId === firmId && s.members.some(x => x.memberId === memberId));
      if (!hasScreening) return sendJson(res, 409, { code: 'SCREENING_REQUIRED', error: '请先完成利益冲突筛查' });
      if (memberConflictState(state, engagementId, memberId).blocking) return sendJson(res, 409, { code: 'CONFLICT_NOT_CLEARED' });
    }
    const ndaId = store.nextId('NDA');
    const requestKey = body.idempotencyKey || `nda-${ndaId}-v1`;
    const signerRefs = memberIds.map(memberId => ({ memberId, ref: `${ndaId}-${memberId}`.replace(/[^A-Za-z0-9_.:-]/g, '_') }));
    const items = signerRefs.map(x => ({ envelopeRef: x.ref, template: body.templateId ?? 'SYNTHETIC-NDA', blindMatter: engagement.id }));
    const nda = {
      id: ndaId, engagementId, firmId, memberIds: [...memberIds], requestKey, signerRefs,
      status: 'submitting', provider: 'local-partner', providerOperations: [], notifications: [],
      createdAt: new Date().toISOString(), effectiveAt: null
    };
    await store.commit(() => {
      state.ndas.push(nda);
      engagement.status = 'signing'; engagement.stage = 'signing';
      store.audit(actor, 'nda.created', { ndaId, engagementId, memberIds });
    });
    let providerResult;
    try {
      providerResult = await signing.createEnvelope(requestKey, items);
    } catch (error) {
      await store.commit(() => {
        nda.status = 'submission_unknown';
        nda.providerError = error.name === 'AbortError' ? 'timeout_or_disconnect_may_still_be_accepted' : 'provider_unreachable';
      });
      return sendJson(res, 202, { nda, warning: '签署请求结果未知；可凭原编号查询，受理不等于生效' });
    }
    const ops = providerResult.body?.results ?? [];
    const operations = signerRefs.map((ref, i) => ({ memberId: ref.memberId, ref: ref.ref, ...(ops[i] ?? providerResult.body ?? {}) }));
    const status = providerResult.status === 200 || providerResult.status === 202 ? summarizeSignerStatus(operations.map(o => o.status)) : 'provider_error';
    await store.commit(() => {
      nda.providerHttpStatus = providerResult.status;
      nda.providerOperations = operations;
      nda.status = status;
      if (status === 'effective') nda.effectiveAt = new Date().toISOString();
    });
    return sendJson(res, providerResult.status === 200 ? 200 : 202, { nda, providerStatus: status, effective: status === 'effective' });
  }

  if ((m = pathname.match(/^\/api\/ndas\/([^/]+)$/)) && req.method === 'GET') {
    const nda = findById(state.ndas, decodeURIComponent(m[1]));
    if (!nda) return sendJson(res, 404, { code: 'NDA_NOT_FOUND' });
    if (actor.role === 'adviser' && nda.firmId !== actor.firm) return sendJson(res, 404, { code: 'NDA_NOT_FOUND' });
    return sendJson(res, 200, { nda });
  }

  async function reconcileNda(nda) {
    const operations = [];
    for (const signer of nda.signerRefs) {
      const result = await signing.lookup(signer.ref);
      operations.push({ memberId: signer.memberId, ref: signer.ref, httpStatus: result.status, ...(result.body ?? {}) });
    }
    const found = operations.filter(op => op.status);
    const status = found.length === nda.signerRefs.length ? summarizeSignerStatus(operations) : (nda.status === 'submitting' ? 'submission_unknown' : nda.status);
    await store.commit(() => {
      nda.providerOperations = operations;
      nda.status = status;
      if (status === 'effective' && !nda.effectiveAt) nda.effectiveAt = new Date().toISOString();
    });
    return status;
  }

  if ((m = pathname.match(/^\/api\/ndas\/([^/]+)\/reconcile$/)) && req.method === 'POST') {
    const nda = findById(state.ndas, decodeURIComponent(m[1]));
    if (!nda) return sendJson(res, 404, { code: 'NDA_NOT_FOUND' });
    if (actor.role === 'adviser' && nda.firmId !== actor.firm) return sendJson(res, 404, { code: 'NDA_NOT_FOUND' });
    const status = await reconcileNda(nda);
    return sendJson(res, 200, { nda, status, effective: status === 'effective' });
  }

  if ((m = pathname.match(/^\/api\/ndas\/([^/]+)\/notifications$/)) && req.method === 'POST') {
    const nda = findById(state.ndas, decodeURIComponent(m[1]));
    if (!nda) return sendJson(res, 404, { code: 'NDA_NOT_FOUND' });
    // 关键边界：通知体里的 memberIds 只记录为不可信观察，绝不合并进原承诺范围。
    const observedExtra = Array.isArray(body.memberIds) ? body.memberIds.filter(x => !nda.memberIds.includes(x)) : [];
    await store.commit(() => {
      nda.notifications.push({ id: store.nextId('NTF'), at: new Date().toISOString(), observedExtraMemberIds: observedExtra, scopeExpanded: false });
      state.notifications.push({ ndaId: nda.id, observedExtraMemberIds: observedExtra, at: new Date().toISOString() });
    });
    let status = nda.status;
    try { status = await reconcileNda(nda); } catch { /* 保持未生效，等待重复通知或轮询 */ }
    return sendJson(res, 200, { received: true, nda, scopeMemberIds: nda.memberIds, scopeExpanded: false, ignoredExtraMemberIds: observedExtra, status, effective: status === 'effective' });
  }

  if ((m = pathname.match(/^\/api\/consent-drafts\/([^/]+)\/approve$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY', error: '秘书处不能替企业同意披露正文' });
    const draft = state.fixtureDrafts.consentDrafts.find(d => d.id === decodeURIComponent(m[1]));
    if (!draft) return sendJson(res, 404, { code: 'DRAFT_NOT_FOUND' });
    const engagement = findById(state.engagements, body.engagementId ?? draft.engagement);
    if (!engagement || engagement.client !== actor.organization) return sendJson(res, 404, { code: 'ENGAGEMENT_NOT_FOUND' });
    const member = findById(state.members, draft.member);
    const payload = {
      firmId: body.firmId ?? member.firm,
      memberIds: body.memberIds ?? [draft.member],
      items: [{ documentId: draft.document, sections: body.sections ?? draft.sections, purposes: body.purposes ?? [draft.purpose] }],
      idempotencyKey: body.idempotencyKey
    };
    const result = await createDisclosureGrants(ctx, engagement, payload, draft.id);
    if (result.error) return sendJson(res, result.error.status, result.error.body);
    return sendJson(res, 201, result.value);
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/disclosures$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY', error: '只有企业能同意披露正文和范围' });
    const found = engagementForActor(state, decodeURIComponent(m[1]), actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    const result = await createDisclosureGrants(ctx, found.engagement, body);
    if (result.error) return sendJson(res, result.error.status, result.error.body);
    return sendJson(res, 201, result.value);
  }

  if (pathname === '/api/disclosures' && req.method === 'GET') {
    let rows = state.disclosures;
    if (actor.role === 'client') rows = rows.filter(d => d.clientOrgId === actor.organization);
    if (actor.role === 'adviser') rows = rows.filter(d => d.firmId === actor.firm && d.memberIds.includes(actor.member));
    return sendJson(res, 200, { disclosures: rows.map(d => ({ ...d, grants: state.grants.filter(g => g.disclosureId === d.id).map(g => ({ ...g, delivery: deliveryProgress(state, g.id) })) })) });
  }

  if ((m = pathname.match(/^\/api\/disclosures\/([^/]+)$/)) && req.method === 'GET') {
    const disclosure = findById(state.disclosures, decodeURIComponent(m[1]));
    if (!disclosure) return sendJson(res, 404, { code: 'DISCLOSURE_NOT_FOUND' });
    if (actor.role === 'client' && disclosure.clientOrgId !== actor.organization) return sendJson(res, 404, { code: 'NOT_FOUND' });
    if (actor.role === 'adviser' && !(disclosure.firmId === actor.firm && disclosure.memberIds.includes(actor.member))) return sendJson(res, 404, { code: 'NOT_FOUND' });
    const grants = state.grants.filter(g => g.disclosureId === disclosure.id).map(g => ({ ...g, delivery: deliveryProgress(state, g.id) }));
    return sendJson(res, 200, { disclosure, grants });
  }

  if ((m = pathname.match(/^\/api\/disclosures\/([^/]+)\/revoke$/)) && req.method === 'POST') {
    const grant = findById(state.grants, decodeURIComponent(m[1]));
    if (!grant) return sendJson(res, 404, { code: 'GRANT_NOT_FOUND' });
    if (actor.role !== 'client' || grant.clientOrgId !== actor.organization) return sendJson(res, 403, { code: 'CLIENT_OWNER_ONLY' });
    await store.commit(() => {
      if (Array.isArray(body.sections) && body.sections.length) grant.sections = grant.sections.filter(s => !body.sections.includes(s));
      if (Array.isArray(body.purposes) && body.purposes.length) grant.purposes = grant.purposes.filter(p => !body.purposes.includes(p));
      if (!body.sections && !body.purposes || !grant.sections.length || !grant.purposes.length) {
        grant.status = 'revoked'; grant.revokedAt = new Date().toISOString(); grant.revocationReason = body.reason ?? 'client_revoked'; grant.sourceChangeId = body.sourceChangeId ?? null;
      }
      store.audit(actor, 'disclosure.revoked', { grantId: grant.id, status: grant.status, sections: body.sections ?? null, purposes: body.purposes ?? null });
    });
    return sendJson(res, 200, { grant, futureDownloads: 'denied_including_resume_and_new_segments', priorDeliveredBytes: 'remain_with_recipient_and_cannot_be_remotely_reclaimed' });
  }

  if ((m = pathname.match(/^\/api\/disclosures\/([^/]+)\/delivery$/)) && req.method === 'GET') {
    const progress = deliveryProgress(state, decodeURIComponent(m[1]));
    if (!progress) return sendJson(res, 404, { code: 'GRANT_NOT_FOUND' });
    const grant = findById(state.grants, progress.grantId);
    if (actor.role === 'client' && grant.clientOrgId !== actor.organization) return sendJson(res, 404, { code: 'NOT_FOUND' });
    if (actor.role === 'adviser' && !(grant.firmId === actor.firm && grant.memberIds.includes(actor.member))) return sendJson(res, 404, { code: 'NOT_FOUND' });
    return sendJson(res, 200, { delivery: progress });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/revoke-materials$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY' });
    const engagement = findById(state.engagements, decodeURIComponent(m[1]));
    if (!engagement || engagement.client !== actor.organization) return sendJson(res, 404, { code: 'ENGAGEMENT_NOT_FOUND' });
    let count = 0;
    await store.commit(() => {
      for (const grant of state.grants.filter(g => g.engagementId === engagement.id && g.status === 'active')) {
        if (body.documentIds?.length && !body.documentIds.includes(grant.documentId) && !body.documentIds.includes(grant.familyId)) continue;
        if (body.memberId && !grant.memberIds.includes(body.memberId)) continue;
        grant.status = 'revoked'; grant.revokedAt = new Date().toISOString(); grant.revocationReason = body.reason ?? 'client_withdrew_materials'; grant.sourceChangeId = body.sourceChangeId ?? null;
        count += 1;
      }
      store.audit(actor, 'materials.revoked', { engagementId: engagement.id, count, memberId: body.memberId ?? null });
    });
    return sendJson(res, 200, { revokedGrants: count, feeDisputeDoesNotPreserveAccess: true });
  }

  if (pathname === '/api/documents' && req.method === 'GET') {
    let docs = state.documents;
    if (actor.role === 'client') docs = docs.filter(d => d.owner === actor.organization);
    if (actor.role === 'adviser') {
      const ids = new Set(state.grants.filter(g => g.status === 'active' && g.memberIds.includes(actor.member)).map(g => g.documentId));
      docs = docs.filter(d => ids.has(d.id));
    }
    return sendJson(res, 200, { documents: docs.map(({ object, storageKey, ...safe }) => safe) });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/documents$/)) && req.method === 'GET') {
    const found = engagementForActor(state, decodeURIComponent(m[1]), actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    const owner = found.engagement.client;
    return sendJson(res, 200, { documents: state.documents.filter(d => d.owner === owner).map(({ object, storageKey, ...safe }) => safe) });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/documents$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY' });
    const engagement = findById(state.engagements, decodeURIComponent(m[1]));
    if (!engagement || engagement.client !== actor.organization) return sendJson(res, 404, { code: 'ENGAGEMENT_NOT_FOUND' });
    const sectionsInput = body.sections ?? [{ code: body.sectionCode ?? 'full', content: body.content ?? '' }];
    if (!Array.isArray(sectionsInput) || !sectionsInput.length || sectionsInput.some(s => !s.code || typeof s.content !== 'string')) {
      return sendJson(res, 400, { code: 'SECTIONS_REQUIRED', error: '合成文件需提供 sections: [{code, content}]' });
    }
    const buffers = sectionsInput.map(s => Buffer.from(s.content, 'utf8'));
    const sectionRanges = {};
    let offset = 0;
    buffers.forEach((buffer, i) => {
      sectionRanges[sectionsInput[i].code] = { startByte: offset, endByte: offset + buffer.length - 1 };
      offset += buffer.length;
    });
    const buffer = Buffer.concat(buffers);
    const base = body.familyId ? resolveDocument(state, body.familyId) : null;
    const familyId = body.familyId ?? base?.familyId;
    const version = body.version ?? (base ? Math.max(...state.documents.filter(d => d.familyId === base.familyId).map(d => d.version)) + 1 : 1);
    const id = body.id ?? store.nextId('DOC');
    const storageKey = `${id}-v${version}.bin`;
    writeFileSync(join(config.localObjectDir, storageKey), buffer);
    const doc = {
      id, owner: actor.organization, familyId: familyId ?? id, version,
      replaces: base?.id ?? null, sections: sectionsInput.map(s => s.code), sectionRanges,
      storage: 'local', storageKey, sizeBytes: buffer.length, sha256: hashBuffer(buffer),
      title: body.title ?? body.fileName ?? `合成资料 ${id}`, createdAt: new Date().toISOString()
    };
    await store.commit(() => {
      state.documents.push(doc);
      if (Array.isArray(engagement.materialScope)) engagement.materialScope.push({ documentId: id, version, categories: body.categories ?? doc.sections });
      store.audit(actor, 'document.uploaded', { documentId: id, version, bytes: buffer.length });
    });
    return sendJson(res, 201, { document: (({ storageKey: _k, ...safe }) => safe)(doc) });
  }

  if ((m = pathname.match(/^\/api\/documents\/([^/]+)$/)) && req.method === 'GET') {
    const doc = resolveDocument(state, decodeURIComponent(m[1]), query.version);
    if (!doc) return sendJson(res, 404, { code: 'DOCUMENT_NOT_FOUND' });
    if (actor.role === 'client' && doc.owner !== actor.organization) return sendJson(res, 404, { code: 'NOT_FOUND' });
    if (actor.role === 'adviser' && !state.grants.some(g => g.status === 'active' && g.documentId === doc.id && g.memberIds.includes(actor.member))) return sendJson(res, 404, { code: 'NOT_FOUND' });
    const { object, storageKey, ...safe } = doc;
    return sendJson(res, 200, { document: safe });
  }

  async function serveByParams(engagementId, documentId, segmentIndex = null) {
    const purpose = query.purpose;
    const section = query.section;
    let startByte;
    let endByte;
    if (segmentIndex !== null) {
      const doc = resolveDocument(state, documentId, query.version);
      if (!doc) return sendJson(res, 404, { code: 'DOCUMENT_NOT_FOUND' });
      const segments = segmentList(doc, config, section);
      const segment = segments?.segments.find(s => s.index === Number(segmentIndex));
      if (!segment) return sendJson(res, 404, { code: 'SEGMENT_NOT_FOUND' });
      startByte = segment.startByte; endByte = segment.endByte;
    } else if (query.startByte !== undefined || query.endByte !== undefined) {
      startByte = Number(query.startByte); endByte = Number(query.endByte);
    }
    return serveAuthorizedDocument(req, res, { store, actor, config, hooks: ctx.hooks, serverLog: ctx.serverLog }, {
      engagementId: query.engagementId ?? engagementId,
      documentId,
      version: query.version,
      purpose,
      section,
      startByte: Number.isInteger(startByte) ? startByte : undefined,
      endByte: Number.isInteger(endByte) ? endByte : undefined
    });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/documents\/([^/]+)\/segments$/)) && req.method === 'GET') {
    const doc = resolveDocument(state, decodeURIComponent(m[2]), query.version);
    if (!doc) return sendJson(res, 404, { code: 'DOCUMENT_NOT_FOUND' });
    const decision = authorizeDocument(state, actor, {
      engagementId: decodeURIComponent(m[1]),
      documentId: doc.id,
      version: doc.version,
      purpose: query.purpose,
      section: query.section
    });
    if (!decision.ok) return sendError(res, decision);
    const list = segmentList(doc, config, query.section);
    return sendJson(res, 200, list);
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/documents\/([^/]+)\/segments\/(\d+)\/content$/)) && req.method === 'GET') {
    return serveByParams(decodeURIComponent(m[1]), decodeURIComponent(m[2]), Number(m[3]));
  }
  if ((m = pathname.match(/^\/api\/documents\/([^/]+)\/segments\/(\d+)\/content$/)) && req.method === 'GET') {
    return serveByParams(query.engagementId, decodeURIComponent(m[1]), Number(m[2]));
  }
  if ((m = pathname.match(/^\/api\/documents\/([^/]+)\/content$/)) && req.method === 'GET') {
    return serveByParams(query.engagementId, decodeURIComponent(m[1]));
  }
  if ((m = pathname.match(/^\/api\/files\/([^/]+)\/(?:content|raw)$/)) && req.method === 'GET') {
    return serveByParams(query.engagementId, decodeURIComponent(m[1]));
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/commission$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY' });
    const engagement = findById(state.engagements, decodeURIComponent(m[1]));
    if (!engagement || engagement.client !== actor.organization) return sendJson(res, 404, { code: 'ENGAGEMENT_NOT_FOUND' });
    const firmId = body.firmId;
    const memberIds = body.memberIds ?? [];
    if (!firmId || !memberIds.length) return sendJson(res, 400, { code: 'FIRM_AND_MEMBERS_REQUIRED' });
    for (const memberId of memberIds) {
      if (!activeMembership(state, engagement.id, memberId)) return sendJson(res, 409, { code: 'MEMBER_NOT_ON_ENGAGEMENT' });
      if (memberConflictState(state, engagement.id, memberId).blocking) return sendJson(res, 409, { code: 'CONFLICT_NOT_CLEARED' });
      if (!effectiveNda(state, engagement.id, memberId, firmId)) return sendJson(res, 409, { code: 'NDA_NOT_EFFECTIVE' });
    }
    const commission = { id: store.nextId('COM'), engagementId: engagement.id, clientOrgId: actor.organization, firmId, memberIds, scope: body.scope ?? engagement.areas, feeRef: body.feeRef ?? null, status: 'active', createdAt: new Date().toISOString() };
    await store.commit(() => {
      for (const old of state.commissions.filter(c => c.engagementId === engagement.id && c.status === 'active')) old.status = 'superseded';
      state.commissions.push(commission);
      engagement.status = 'in_delivery'; engagement.stage = 'delivery';
      store.audit(actor, 'commission.confirmed', { commissionId: commission.id, firmId, memberIds });
    });
    return sendJson(res, 201, { commission });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/complete$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY' });
    const engagement = findById(state.engagements, decodeURIComponent(m[1]));
    if (!engagement || engagement.client !== actor.organization) return sendJson(res, 404, { code: 'NOT_FOUND' });
    await store.commit(() => {
      for (const c of state.commissions.filter(c => c.engagementId === engagement.id && c.status === 'active')) { c.status = 'completed'; c.completedAt = new Date().toISOString(); }
      engagement.status = 'completed'; engagement.stage = 'closed';
      store.audit(actor, 'engagement.completed', { engagementId: engagement.id, note: body.note ?? null });
    });
    return sendJson(res, 200, { engagement: clientEngagementView(state, engagement, actor) });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/terminate$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY' });
    const engagement = findById(state.engagements, decodeURIComponent(m[1]));
    if (!engagement || engagement.client !== actor.organization) return sendJson(res, 404, { code: 'NOT_FOUND' });
    await store.commit(() => {
      for (const c of state.commissions.filter(c => c.engagementId === engagement.id && c.status === 'active')) { c.status = 'terminated'; c.terminatedAt = new Date().toISOString(); }
      if (body.withdrawMaterials !== false) {
        for (const g of state.grants.filter(g => g.engagementId === engagement.id && g.status === 'active')) {
          g.status = 'revoked'; g.revokedAt = new Date().toISOString(); g.revocationReason = 'engagement_terminated';
        }
      }
      engagement.status = 'terminated'; engagement.stage = 'closed';
      store.audit(actor, 'engagement.terminated', { engagementId: engagement.id, withdrawMaterials: body.withdrawMaterials !== false });
    });
    return sendJson(res, 200, { status: 'terminated', materialsWithdrawn: body.withdrawMaterials !== false });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/disputes$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'adviser', 'client')) return sendJson(res, 403, { code: 'ROLE_DENIED' });
    const engagement = findById(state.engagements, decodeURIComponent(m[1]));
    if (!engagement) return sendJson(res, 404, { code: 'NOT_FOUND' });
    const dispute = { id: store.nextId('FEE'), engagementId: engagement.id, invoiceRef: body.invoiceRef ?? null, amount: body.amount ?? null, currency: body.currency ?? 'CNY', note: body.note ?? '', status: 'open', raisedBy: actor.id, at: new Date().toISOString() };
    await store.commit(() => { state.disputes.push(dispute); store.audit(actor, 'fee_dispute.recorded', { disputeId: dispute.id }); });
    return sendJson(res, 201, { dispute, accessEffect: 'none', explanation: '费用争议可留痕，但不能作为继续访问企业已撤回原始资料的依据' });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/subcontracts$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'adviser')) return sendJson(res, 403, { code: 'ADVISER_ONLY' });
    const engagement = findById(state.engagements, decodeURIComponent(m[1]));
    if (!engagement) return sendJson(res, 404, { code: 'NOT_FOUND' });
    const subcontract = { id: store.nextId('SUB'), engagementId: engagement.id, parentFirmId: actor.firm, subcontractorFirmId: body.subcontractorFirmId, memberIds: body.memberIds ?? [], purposes: body.purposes ?? ['perform'], status: 'requested', createdAt: new Date().toISOString() };
    await store.commit(() => { state.subcontracts.push(subcontract); store.audit(actor, 'subcontract.requested', { subcontractId: subcontract.id }); });
    return sendJson(res, 201, { subcontract, warning: '报价阅读权默认不得分包；需企业明确授权且分包人员满足 NDA/冲突条件' });
  }

  if ((m = pathname.match(/^\/api\/subcontracts\/([^/]+)\/decision$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY' });
    const subcontract = findById(state.subcontracts, decodeURIComponent(m[1]));
    if (!subcontract) return sendJson(res, 404, { code: 'SUBContracts_NOT_FOUND' });
    subcontract.status = body.decision === 'approve' ? 'approved' : 'rejected';
    subcontract.decidedAt = new Date().toISOString();
    await store.commit(() => {
      if (subcontract.status === 'approved') {
        for (const memberId of subcontract.memberIds) {
          if (!activeMembership(state, subcontract.engagementId, memberId)) {
            state.teamMemberships.push({
              id: store.nextId('TM'), engagementId: subcontract.engagementId,
              firmId: subcontract.subcontractorFirmId, memberId, status: 'active',
              reason: 'approved_subcontractor', createdAt: new Date().toISOString()
            });
          }
        }
      }
      store.audit(actor, 'subcontract.decided', { subcontractId: subcontract.id, status: subcontract.status });
    });
    return sendJson(res, 200, { subcontract });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/work-products$/)) && req.method === 'GET') {
    const engagement = findById(state.engagements, decodeURIComponent(m[1]));
    if (!engagement) return sendJson(res, 404, { code: 'NOT_FOUND' });
    let rows = state.workProducts.filter(w => w.engagementId === engagement.id);
    if (actor.role === 'adviser') rows = rows.filter(w => w.originFirmId === actor.firm || state.handoffs.some(h => h.toFirmId === actor.firm && h.items.some(i => i.workProductId === w.id && i.clientApproved)));
    return sendJson(res, 200, { workProducts: rows });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/work-products$/)) && req.method === 'POST') {
    const found = engagementForActor(state, decodeURIComponent(m[1]), actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    if (!requireRole(actor, 'adviser')) return sendJson(res, 403, { code: 'ADVISER_ONLY' });
    let draft = null;
    if (body.draftId) {
      draft = state.fixtureDrafts.workDrafts.find(d => d.id === body.draftId);
      if (!draft) return sendJson(res, 404, { code: 'WORK_DRAFT_NOT_FOUND' });
    }
    const result = await createWorkProduct(ctx, found.engagement, body, draft);
    if (result.error) return sendJson(res, result.error.status ?? 400, result.error.body ?? result.error);
    return sendJson(res, result.status ?? 201, { workProduct: result.value });
  }

  if ((m = pathname.match(/^\/api\/work-products\/([^/]+)\/content$/)) && req.method === 'GET') {
    const wp = findById(state.workProducts, decodeURIComponent(m[1]));
    if (!wp) return sendJson(res, 404, { code: 'WORK_PRODUCT_NOT_FOUND' });
    const decision = authorizeWorkContent(state, actor, wp);
    if (!decision.ok) return sendJson(res, decision.status, { code: decision.code, error: decision.error });
    const filePath = join(config.localObjectDir, wp.storageKey);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': wp.sizeBytes, 'x-work-product-id': wp.id });
    createReadStream(filePath).on('error', () => { if (!res.writableEnded) sendJson(res, 410, { code: 'OBJECT_MISSING' }); }).pipe(res);
    return;
  }

  if ((m = pathname.match(/^\/api\/work-products\/([^/]+)$/)) && req.method === 'GET') {
    const wp = findById(state.workProducts, decodeURIComponent(m[1]));
    if (!wp) return sendJson(res, 404, { code: 'WP_NOT_FOUND' });
    if (actor.role === 'adviser' && wp.originFirmId !== actor.firm && !state.handoffs.some(h => h.toFirmId === actor.firm && h.items.some(i => i.workProductId === wp.id && i.clientApproved))) {
      return sendJson(res, 404, { code: 'WP_NOT_FOUND' });
    }
    return sendJson(res, 200, { workProduct: wp });
  }

  if ((m = pathname.match(/^\/api\/work-products\/([^/]+)\/accept$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY' });
    const wp = findById(state.workProducts, decodeURIComponent(m[1]));
    const engagement = wp && findById(state.engagements, wp.engagementId);
    if (!wp || !engagement || engagement.client !== actor.organization) return sendJson(res, 404, { code: 'WP_NOT_FOUND' });
    await store.commit(() => {
      wp.status = body.partial ? 'partially_accepted' : 'accepted';
      wp.review = { decision: body.partial ? 'accepted_partial' : 'accepted', acceptedParts: body.acceptedParts ?? (body.partial ? [] : 'all'), note: body.note ?? '', at: new Date().toISOString(), by: actor.id };
      store.audit(actor, 'work_product.accepted', { workProductId: wp.id, partial: !!body.partial });
    });
    return sendJson(res, 200, { workProduct: wp });
  }

  if ((m = pathname.match(/^\/api\/work-products\/([^/]+)\/supplement$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY' });
    const wp = findById(state.workProducts, decodeURIComponent(m[1]));
    const engagement = wp && findById(state.engagements, wp.engagementId);
    if (!wp || !engagement || engagement.client !== actor.organization) return sendJson(res, 404, { code: 'WP_NOT_FOUND' });
    await store.commit(() => {
      wp.status = 'supplement_required';
      wp.review = { decision: 'supplement_required', requests: body.requests ?? [], note: body.note ?? '', dueAt: body.dueAt ?? null, at: new Date().toISOString(), by: actor.id };
      engagement.status = 'supplement_required'; engagement.stage = 'delivery';
      store.audit(actor, 'work_product.supplement_requested', { workProductId: wp.id });
    });
    return sendJson(res, 200, { workProduct: wp });
  }

  if ((m = pathname.match(/^\/api\/engagements\/([^/]+)\/handoffs$/)) && req.method === 'POST') {
    const found = engagementForActor(state, decodeURIComponent(m[1]), actor);
    if (found.error) return sendJson(res, found.error.status, found.error.body);
    if (!requireRole(actor, 'secretariat', 'adviser', 'client')) return sendJson(res, 403, { code: 'ROLE_DENIED' });
    if (!body.toFirmId || !Array.isArray(body.memberIds) || !body.memberIds.length) return sendJson(res, 400, { code: 'SUCCESSOR_AND_MEMBERS_REQUIRED' });
    const handoff = {
      id: store.nextId('HO'), engagementId: found.engagement.id, fromFirmId: body.fromFirmId ?? state.commissions.find(c => c.engagementId === found.engagement.id && c.status === 'active')?.firmId ?? actor.firm ?? null,
      toFirmId: body.toFirmId, memberIds: body.memberIds, status: 'draft', items: [], createdAt: new Date().toISOString(), clientApprovedAt: null, originReleasedAt: null, acceptedAt: null, completedAt: null
    };
    await store.commit(() => {
      for (const wpId of body.workProductIds ?? []) {
        const wp = findById(state.workProducts, wpId);
        if (!wp || wp.engagementId !== found.engagement.id) continue;
        handoff.items.push({ kind: 'workProduct', workProductId: wpId, clientApproved: false, originReleaseRequired: !!wp.transfer?.requiresOriginConsent, originReleased: false, status: 'listed_only' });
      }
      for (const documentId of body.documentIds ?? []) {
        handoff.items.push({ kind: 'document', documentId, clientScopeApproved: false, grantId: null, status: 'listed_only' });
      }
      state.handoffs.push(handoff);
      for (const memberId of body.memberIds) {
        const member = findById(state.members, memberId);
        if (member && !activeMembership(state, found.engagement.id, memberId)) {
          state.teamMemberships.push({ id: store.nextId('TM'), engagementId: found.engagement.id, firmId: body.toFirmId, memberId, status: 'active', reason: 'handoff_designation', createdAt: new Date().toISOString() });
        }
      }
      found.engagement.status = 'handoff'; found.engagement.stage = 'handoff';
      store.audit(actor, 'handoff.draft_created', { handoffId: handoff.id, listedWorkProducts: body.workProductIds?.length ?? 0 });
    });
    return sendJson(res, 201, { handoff, warning: '清单不授予读取权；必须逐项完成企业同意、前任放行和当前资格校验' });
  }

  if ((m = pathname.match(/^\/api\/handoffs\/([^/]+)$/)) && req.method === 'GET') {
    const handoff = findById(state.handoffs, decodeURIComponent(m[1]));
    if (!handoff) return sendJson(res, 404, { code: 'HANDOFF_NOT_FOUND' });
    if (actor.role === 'adviser' && ![handoff.toFirmId, handoff.fromFirmId].includes(actor.firm)) return sendJson(res, 404, { code: 'NOT_FOUND' });
    return sendJson(res, 200, { handoff, completed: handoff.status === 'completed' });
  }

  if ((m = pathname.match(/^\/api\/handoffs\/([^/]+)\/client-approval$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client')) return sendJson(res, 403, { code: 'CLIENT_ONLY' });
    const handoff = findById(state.handoffs, decodeURIComponent(m[1]));
    const engagement = handoff && findById(state.engagements, handoff.engagementId);
    if (!handoff || engagement.client !== actor.organization) return sendJson(res, 404, { code: 'HANDOFF_NOT_FOUND' });
    const approveIds = new Set(body.workProductIds ?? body.approveWorkProductIds ?? []);
    if (body.approveAllListedWorks === true) handoff.items.filter(i => i.kind === 'workProduct').forEach(i => approveIds.add(i.workProductId));
    for (const wpId of approveIds) {
      const item = handoff.items.find(i => i.kind === 'workProduct' && i.workProductId === wpId);
      if (item) { item.clientApproved = true; item.status = item.originReleaseRequired ? 'awaiting_origin_release' : 'authorized_pending_eligibility'; }
    }
    if (Array.isArray(body.documentGrants) && body.documentGrants.length) {
      const payload = { firmId: handoff.toFirmId, memberIds: handoff.memberIds, items: body.documentGrants };
      const result = await createDisclosureGrants(ctx, engagement, payload, `handoff:${handoff.id}`);
      if (result.error) return sendJson(res, result.error.status, result.error.body);
      await store.commit(() => {
        result.value.grants.forEach((grant, index) => {
          const input = body.documentGrants[index];
          let item = handoff.items.find(i => i.kind === 'document' && (i.documentId === input.documentId || resolveDocument(state, i.documentId)?.familyId === grant.familyId));
          if (!item) { item = { kind: 'document', documentId: grant.documentId }; handoff.items.push(item); }
          Object.assign(item, { documentId: grant.documentId, grantId: grant.id, clientScopeApproved: true, status: 'authorized_pending_eligibility' });
        });
        result.value.disclosure.handoffId = handoff.id;
      });
    }
    handoff.clientApprovedAt = new Date().toISOString();
    handoff.status = 'awaiting_origin_release_or_acceptance';
    await store.commit(() => store.audit(actor, 'handoff.client_approval', { handoffId: handoff.id, workProductIds: [...approveIds] }));
    return sendJson(res, 200, { handoff });
  }

  if ((m = pathname.match(/^\/api\/handoffs\/([^/]+)\/release$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'adviser')) return sendJson(res, 403, { code: 'ADVISER_ONLY' });
    const handoff = findById(state.handoffs, decodeURIComponent(m[1]));
    if (!handoff) return sendJson(res, 404, { code: 'NOT_FOUND' });
    await store.commit(() => {
      const ids = new Set(body.workProductIds ?? []);
      for (const item of handoff.items.filter(i => i.kind === 'workProduct')) {
        const wp = findById(state.workProducts, item.workProductId);
        if (wp?.originFirmId !== actor.firm) continue;
        if (!ids.size || ids.has(item.workProductId)) {
          item.originReleased = true;
          if (item.clientApproved) item.status = 'authorized_pending_eligibility';
        }
      }
      handoff.originReleasedAt = new Date().toISOString();
      store.audit(actor, 'handoff.origin_release', { handoffId: handoff.id, workProductIds: body.workProductIds ?? 'all_owned' });
    });
    return sendJson(res, 200, { handoff });
  }

  if ((m = pathname.match(/^\/api\/handoffs\/([^/]+)\/accept$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'adviser')) return sendJson(res, 403, { code: 'ADVISER_ONLY' });
    const handoff = findById(state.handoffs, decodeURIComponent(m[1]));
    if (!handoff || handoff.toFirmId !== actor.firm || !handoff.memberIds.includes(actor.member)) return sendJson(res, 404, { code: 'HANDOFF_NOT_FOUND' });
    const failures = [];
    for (const item of handoff.items) {
      if (item.status === 'excluded') continue;
      if (item.kind === 'workProduct') {
        const wp = findById(state.workProducts, item.workProductId);
        const decision = authorizeWorkContent(state, actor, wp);
        if (!decision.ok) failures.push({ item, code: decision.code });
      } else if (item.kind === 'document' && item.grantId) {
        const grant = findById(state.grants, item.grantId);
        for (const purpose of grant?.purposes ?? ['quote']) {
          for (const section of grant?.sections ?? []) {
            const decision = authorizeDocument(state, actor, { engagementId: handoff.engagementId, documentId: grant.documentId, version: grant.version, purpose, section });
            if (!decision.ok) failures.push({ item: { ...item, purpose, section }, code: decision.code });
          }
        }
      }
    }
    if (failures.length) return sendJson(res, 409, { code: 'HANDOFF_ITEMS_NOT_READY', failures });
    await store.commit(() => { handoff.status = 'accepted'; handoff.acceptedAt = new Date().toISOString(); handoff.acceptedBy = actor.id; store.audit(actor, 'handoff.accepted', { handoffId: handoff.id }); });
    return sendJson(res, 200, { handoff });
  }

  if ((m = pathname.match(/^\/api\/handoffs\/([^/]+)\/complete$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client', 'secretariat')) return sendJson(res, 403, { code: 'CLIENT_OR_SECRETARY_ONLY' });
    const handoff = findById(state.handoffs, decodeURIComponent(m[1]));
    if (!handoff) return sendJson(res, 404, { code: 'NOT_FOUND' });
    if (handoff.status !== 'accepted' && body.force !== true) return sendJson(res, 409, { code: 'HANDOFF_NOT_ACCEPTED', status: handoff.status });
    await store.commit(() => {
      handoff.status = 'completed'; handoff.completedAt = new Date().toISOString();
      const engagement = findById(state.engagements, handoff.engagementId);
      if (engagement) { engagement.status = 'handoff_completed'; engagement.stage = 'handoff'; }
      store.audit(actor, 'handoff.completed', { handoffId: handoff.id });
    });
    return sendJson(res, 200, { handoff, completed: true });
  }

  if ((m = pathname.match(/^\/api\/handoffs\/([^/]+)\/exclude-items$/)) && req.method === 'POST') {
    if (!requireRole(actor, 'client', 'secretariat')) return sendJson(res, 403, { code: 'ROLE_DENIED' });
    const handoff = findById(state.handoffs, decodeURIComponent(m[1]));
    if (!handoff) return sendJson(res, 404, { code: 'NOT_FOUND' });
    await store.commit(() => {
      for (const item of handoff.items) if (body.keys?.includes(`${item.kind}:${item.workProductId ?? item.documentId}`)) item.status = 'excluded';
    });
    return sendJson(res, 200, { handoff });
  }

  // __WORK_AND_HANDOFF_ROUTES__

  return sendJson(res, 404, { code: 'ROUTE_NOT_FOUND', error: '没有对应的业务接口' });
}
