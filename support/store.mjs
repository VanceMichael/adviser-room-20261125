import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = join(ROOT, 'fixtures');
export const FIXTURE_OBJECT_DIR = join(ROOT, 'objects');
export const fixtureRecords = JSON.parse(readFileSync(join(FIXTURE_DIR, 'records.json'), 'utf8'));
export const partnerConfig = JSON.parse(readFileSync(join(FIXTURE_DIR, 'partner.json'), 'utf8'));

export function nowIso() {
  return new Date().toISOString();
}

function familyRoot(doc, byId) {
  let current = doc;
  const seen = new Set();
  while (current?.replaces && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.replaces);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

export function seedState(records = fixtureRecords) {
  const byId = new Map(records.documents.map(d => [d.id, d]));
  const extraMembers = [
    { id: 'USER-C', firm: 'ADV-A', name: '合成后加入成员丙', affiliations: [] },
    { id: 'USER-S', firm: 'ADV-B', name: '合成接任成员', affiliations: [] }
  ];
  const extraActors = [
    { id: 'adviser-c', role: 'adviser', member: 'USER-C', firm: 'ADV-A', name: '合成顾问丙接口' },
    { id: 'adviser-successor', role: 'adviser', member: 'USER-S', firm: 'ADV-B', organization: 'ADV-B', name: '合成接任顾问接口' },
    { id: 'counterparty-b', role: 'counterparty', organization: 'ORG-B', name: '合成对手方书面豁免接口' }
  ];
  const organizations = [
    ...records.organizations,
    { id: 'ORG-C', name: '合成保密其他客户丙' },
    { id: 'ORG-D', name: '合成其他关联方丁' }
  ];
  return {
    schemaVersion: 1,
    counters: { seq: 100 },
    organizations,
    members: [...records.members, ...extraMembers],
    actors: [...records.actors, ...extraActors],
    documents: records.documents.map(d => ({
      ...d,
      familyId: familyRoot(d, byId),
      storage: 'fixture',
      status: 'active',
      sizeBytes: statSync(join(FIXTURE_OBJECT_DIR, d.object)).size
    })),
    fixtureDrafts: {
      consentDrafts: records.consentDrafts,
      workDrafts: records.workDrafts,
      sourceChanges: records.sourceChanges
    },
    // 仅秘书处和服务端可见的保管对应关系；顾问接口必须经过脱敏。
    secretMappings: [
      { id: 'SM-USER-B-ORGB', memberId: 'USER-B', organizationId: 'ORG-B', code: 'AFFILIATION_MATCH' },
      { id: 'SM-HIDDEN-ROSTER', memberId: 'USER-B', organizationId: 'ORG-D', code: 'AFFILIATION_MATCH' }
    ],
    secretOtherMatters: [
      { id: 'SECRET-ROSTER-1', client: 'ORG-C', counterparties: ['ORG-D'], note: '用于验证拒绝接单不会带出的其他企业名单' }
    ],
    engagements: records.engagements.map(e => ({
      ...e,
      relatedParties: [],
      materialScope: [],
      status: 'submitted',
      stage: 'submitted',
      createdBy: 'client',
      createdAt: '2026-11-26T00:00:00.000Z'
    })),
    teamMemberships: [
      { id: 'TM-SEED-A', engagementId: 'ENG-1', firmId: 'ADV-A', memberId: 'USER-A', status: 'active', reason: 'synthetic-actor-bootstrap', createdAt: '2026-11-26T00:00:00.000Z', removedAt: null }
    ],
    inquiries: [],
    screenings: [],
    ndas: [],
    grants: [],
    disclosures: [],
    commissions: [],
    workProducts: [],
    handoffs: [],
    disputes: [],
    subcontracts: [],
    accessEvents: [],
    auditEvents: [],
    notifications: []
  };
}

export class JsonStore {
  constructor({ stateFile, state, save = true } = {}) {
    this.stateFile = stateFile ? resolve(stateFile) : null;
    this.saveEnabled = save;
    this.chain = Promise.resolve();
    if (state) this.state = state;
    else if (stateFile) {
      try {
        this.state = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.state = seedState();
        this.save();
      }
    } else {
      this.state = seedState();
    }
  }

  nextId(prefix) {
    this.state.counters ||= { seq: 100 };
    this.state.counters.seq += 1;
    return `${prefix}-${this.state.counters.seq}`;
  }

  save() {
    if (!this.saveEnabled || !this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.stateFile);
  }

  // 所有写命令在同一进程内串行提交，避免成员更换、撤权和交接交叉写入。
  commit(mutator) {
    const run = this.chain.then(() => {
      const result = mutator(this.state);
      this.save();
      return result;
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async exclusive(task) {
    const run = this.chain.then(() => task());
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  audit(actor, action, details = {}) {
    const event = {
      id: this.nextId('AUD'),
      at: nowIso(),
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      action,
      ...details
    };
    this.state.auditEvents.push(event);
    return event;
  }
}

export function findById(rows, id) {
  return rows.find(row => row.id === id) ?? null;
}

export function actorFromRequest(state, req) {
  const headerActor = req.headers['x-actor-id'];
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const actorId = typeof headerActor === 'string' && headerActor ? headerActor : bearer;
  if (!actorId) return { error: { status: 401, body: { error: '需要 X-Actor-Id 本地合成角色头', code: 'AUTH_REQUIRED' } } };
  const actor = findById(state.actors, actorId);
  if (!actor) return { error: { status: 401, body: { error: '未识别的本地合成角色', code: 'AUTH_REQUIRED' } } };
  if (actor.role === 'adviser' && !actor.firm) {
    const member = findById(state.members, actor.member);
    if (member) actor.firm = member.firm;
  }
  return { actor };
}

export function requireRole(actor, ...roles) {
  return roles.includes(actor.role);
}

export function safeObjectPath(root, storageKey) {
  const resolvedRoot = resolve(root);
  const full = resolve(resolvedRoot, storageKey);
  if (!full.startsWith(resolvedRoot + '/')) throw new Error('非法文件路径');
  return full;
}

export function documentAbsolutePath(doc, options) {
  if (doc.storage === 'local') {
    return safeObjectPath(options.localObjectDir, doc.storageKey);
  }
  const name = isAbsolute(doc.object) ? doc.object : join(options.fixtureObjectDir, doc.object);
  const full = resolve(name);
  if (!full.startsWith(resolve(options.fixtureObjectDir) + '/')) throw new Error('非法资料路径');
  return full;
}

export function resolveDocument(state, idOrFamily, version) {
  const exact = findById(state.documents, idOrFamily);
  if (exact && (version === undefined || Number(exact.version) === Number(version))) return exact;
  const candidates = state.documents.filter(d => d.familyId === idOrFamily || d.id === idOrFamily);
  if (version !== undefined) return candidates.find(d => Number(d.version) === Number(version)) ?? null;
  if (exact) return exact;
  return candidates.sort((a, b) => b.version - a.version)[0] ?? null;
}

export function memberConflictState(state, engagementId, memberId) {
  const records = [];
  for (const screening of state.screenings) {
    if (screening.engagementId !== engagementId) continue;
    const item = screening.members?.find(m => m.memberId === memberId);
    if (!item) continue;
    let effective = 'clear';
    if (item.check === 'manual_review_required') {
      if (item.review === 'clear') effective = 'clear';
      else if (item.review === 'conflict_confirmed') {
        effective = item.waivers?.client && item.waivers?.counterparty ? 'waived' : 'conflict';
      } else effective = 'review_pending';
    }
    records.push({ screeningId: screening.id, ...item, effective });
  }
  const blocking = records.find(r => r.effective === 'review_pending' || r.effective === 'conflict');
  return { blocking: blocking ?? null, records };
}

export function effectiveNda(state, engagementId, memberId, firmId) {
  return state.ndas.find(n =>
    n.engagementId === engagementId &&
    n.status === 'effective' &&
    (!firmId || n.firmId === firmId) &&
    n.memberIds.includes(memberId)
  ) ?? null;
}

export function activeMembership(state, engagementId, memberId) {
  return state.teamMemberships.find(t =>
    t.engagementId === engagementId && t.memberId === memberId && t.status === 'active'
  ) ?? null;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

export function authorizeDocument(state, actor, input) {
  if (!actor || actor.role !== 'adviser' || !actor.member) {
    return { ok: false, status: 403, code: 'ADVISER_ONLY', error: '只有顾问成员可以访问资料内容' };
  }
  const { engagementId, purpose } = input;
  if (!engagementId || !purpose) {
    return { ok: false, status: 400, code: 'ENGAGEMENT_AND_PURPOSE_REQUIRED', error: '必须提供事项和用途' };
  }
  const engagement = findById(state.engagements, engagementId);
  if (!engagement) return { ok: false, status: 404, code: 'ENGAGEMENT_NOT_FOUND', error: '事项不存在' };
  const doc = resolveDocument(state, input.documentId, input.version);
  if (!doc) return { ok: false, status: 404, code: 'DOCUMENT_NOT_FOUND', error: '文件版本不存在' };

  const memberId = actor.member;
  const firmId = actor.firm || findById(state.members, memberId)?.firm;
  if (!activeMembership(state, engagementId, memberId)) {
    return { ok: false, status: 403, code: 'TEAM_MEMBER_INACTIVE', error: '该成员已不在事项顾问组，后续访问按新成员状态拒绝' };
  }
  const conflict = memberConflictState(state, engagementId, memberId);
  if (conflict.blocking) {
    return { ok: false, status: 403, code: 'CONFLICT_NOT_CLEARED', error: '利益冲突尚待人工核查或缺少双方书面豁免' };
  }
  if (!effectiveNda(state, engagementId, memberId, firmId)) {
    return { ok: false, status: 403, code: 'NDA_NOT_EFFECTIVE', error: '保密承诺尚未经电子签署终态确认生效' };
  }

  const sectionRange = input.section ? doc.sectionRanges?.[input.section] : null;
  if (input.section && !sectionRange) {
    return { ok: false, status: 400, code: 'SECTION_NOT_FOUND', error: '章节不存在' };
  }
  const wholeStart = sectionRange?.startByte ?? 0;
  const wholeEnd = sectionRange?.endByte ?? doc.sizeBytes - 1;
  const requestedStart = Number.isInteger(input.startByte) ? input.startByte : wholeStart;
  const requestedEnd = Number.isInteger(input.endByte) ? input.endByte : wholeEnd;
  if (requestedStart < 0 || requestedEnd < requestedStart || requestedEnd >= doc.sizeBytes) {
    return { ok: false, status: 416, code: 'RANGE_NOT_SATISFIABLE', error: '分段范围不合法' };
  }
  if (input.section && (requestedStart < wholeStart || requestedEnd > wholeEnd)) {
    return { ok: false, status: 403, code: 'SECTION_NOT_AUTHORIZED', error: '请求范围超出已授权章节' };
  }
  const sectionEntries = Object.entries(doc.sectionRanges || {});
  const overlapping = sectionEntries
    .filter(([, range]) => rangesOverlap(requestedStart, requestedEnd, range.startByte, range.endByte))
    .map(([code]) => code);
  if (!overlapping.length) overlapping.push('__binary__');

  const grants = state.grants.filter(g =>
    g.status === 'active' &&
    g.engagementId === engagementId &&
    g.documentId === doc.id &&
    g.memberIds.includes(memberId)
  );
  const grant = grants.find(g =>
    g.purposes.includes(purpose) &&
    overlapping.every(code => g.sections.includes(code))
  );
  if (!grant) {
    return { ok: false, status: 403, code: 'DISCLOSURE_SCOPE_DENIED', error: '当前企业授权的版本、章节或用途不覆盖该请求' };
  }
  if (grant.firmId !== firmId) {
    const subcontract = state.subcontracts.find(s =>
      s.status === 'approved' &&
      s.engagementId === engagementId &&
      s.parentFirmId === grant.firmId &&
      s.subcontractorFirmId === firmId &&
      s.memberIds.includes(memberId) &&
      s.purposes.includes(purpose)
    );
    if (!grant.allowSubcontracting || !subcontract) {
      return { ok: false, status: 403, code: 'SUBCONTRACT_FORBIDDEN', error: '报价阅读权不包含分包或转授权' };
    }
  }
  if (purpose === 'perform') {
    const commission = state.commissions.find(c =>
      c.engagementId === engagementId && c.status === 'active' &&
      c.firmId === firmId && c.memberIds.includes(memberId)
    );
    if (!commission) return { ok: false, status: 403, code: 'COMMISSION_REQUIRED', error: '开展业务需要企业确认委托，报价阅读权不等于受托经营权' };
  }
  return { ok: true, doc, grant, firmId, memberId, startByte: requestedStart, endByte: requestedEnd, sections: overlapping };
}

export function mergeByteRanges(ranges) {
  const sorted = ranges
    .filter(r => Number.isInteger(r.startByte) && Number.isInteger(r.endByte))
    .map(r => ({ startByte: r.startByte, endByte: r.endByte }))
    .sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.startByte > last.endByte + 1) merged.push({ ...range });
    else last.endByte = Math.max(last.endByte, range.endByte);
  }
  return merged.map(r => ({ ...r, bytes: r.endByte - r.startByte + 1 }));
}

export function deliveryProgress(state, grantId) {
  const grant = findById(state.grants, grantId);
  if (!grant) return null;
  const events = state.accessEvents.filter(e => e.grantId === grantId && ['fulfilled', 'interrupted'].includes(e.status));
  const deliveredEvents = events.filter(e => Number.isInteger(e.deliveredEndByte));
  const merged = mergeByteRanges(deliveredEvents.map(e => ({
    startByte: e.deliveredStartByte ?? e.startByte,
    endByte: e.deliveredEndByte
  })));
  return {
    grantId,
    authorized: {
      documentId: grant.documentId,
      version: grant.version,
      sections: grant.sections,
      purposes: grant.purposes,
      memberIds: grant.memberIds,
      firmId: grant.firmId,
      status: grant.status
    },
    downloadedRanges: merged,
    downloadedBytes: merged.reduce((sum, r) => sum + r.bytes, 0),
    eventCount: events.length,
    fulfilledEventCount: events.filter(e => e.status === 'fulfilled').length,
    interruptedEventCount: events.filter(e => e.status === 'interrupted').length,
    note: '已成功写出的字节无法远程收回；interrupted 记录撤权/中断前服务端已写出的区间。'
  };
}
