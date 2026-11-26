import { findById, deliveryProgress, memberConflictState } from './store.mjs';

function orgName(state, id) {
  return findById(state.organizations, id)?.name ?? id ?? null;
}
function memberName(state, id) {
  return findById(state.members, id)?.name ?? id ?? null;
}

export function bottleneck(state, engagement) {
  const inquiries = state.inquiries.filter(x => x.engagementId === engagement.id);
  const screenings = state.screenings.filter(x => x.engagementId === engagement.id);
  const ndas = state.ndas.filter(x => x.engagementId === engagement.id);
  const grants = state.grants.filter(x => x.engagementId === engagement.id && x.status === 'active');
  const handoffs = state.handoffs.filter(x => x.engagementId === engagement.id);
  const pendingScreening = screenings.some(s => s.members.some(m => {
    const cs = memberConflictState(state, engagement.id, m.memberId);
    return cs.blocking;
  }));
  const pendingNda = ndas.some(n => n.status !== 'effective' && n.status !== 'failed');
  const openHandoff = handoffs.some(h => h.status !== 'completed');
  let code = 'client_consent';
  let label = '企业同意';
  if (['completed', 'closed'].includes(engagement.status)) { code = 'closed'; label = '已结束'; }
  else if (openHandoff || engagement.status === 'handoff') { code = 'handoff'; label = '交接'; }
  else if (['in_delivery', 'supplement_required'].includes(engagement.status)) { code = 'delivery'; label = '受托工作'; }
  else if (pendingScreening || ['submitted', 'screening'].includes(engagement.status) || (!screenings.length && inquiries.length)) { code = 'screening'; label = '征询/利益冲突筛查'; }
  else if (pendingNda || engagement.status === 'signing') { code = 'signing'; label = '保密承诺签署'; }
  else if (!grants.length) { code = 'client_consent'; label = '企业同意披露'; }
  else { code = 'disclosed'; label = '已披露/待委托'; }
  return {
    code,
    label,
    pendingScreening,
    pendingNda,
    activeGrants: grants.length,
    openHandoffs: handoffs.filter(h => h.status !== 'completed').length
  };
}

export function secretaryEngagementView(state, engagement) {
  return {
    ...engagement,
    bottleneck: bottleneck(state, engagement),
    parties: {
      client: { id: engagement.client, name: orgName(state, engagement.client) },
      counterparties: (engagement.counterparties || []).map(id => ({ id, name: orgName(state, id) })),
      relatedParties: (engagement.relatedParties || []).map(id => ({ id, name: orgName(state, id) }))
    },
    team: state.teamMemberships.filter(t => t.engagementId === engagement.id),
    inquiries: state.inquiries.filter(x => x.engagementId === engagement.id),
    screenings: state.screenings.filter(x => x.engagementId === engagement.id),
    ndas: state.ndas.filter(x => x.engagementId === engagement.id),
    disclosures: state.disclosures.filter(x => x.engagementId === engagement.id),
    grants: state.grants.filter(x => x.engagementId === engagement.id).map(g => ({ ...g, delivery: deliveryProgress(state, g.id) })),
    commissions: state.commissions.filter(x => x.engagementId === engagement.id),
    workProducts: state.workProducts.filter(x => x.engagementId === engagement.id),
    handoffs: state.handoffs.filter(x => x.engagementId === engagement.id),
    disputes: state.disputes.filter(x => x.engagementId === engagement.id)
  };
}

export function clientEngagementView(state, engagement, actor) {
  const grants = state.grants.filter(g => g.engagementId === engagement.id);
  return {
    ...engagement,
    bottleneck: bottleneck(state, engagement),
    parties: {
      client: { id: engagement.client, name: orgName(state, engagement.client) },
      counterparties: (engagement.counterparties || []).map(id => ({ id, name: orgName(state, id) })),
      relatedParties: (engagement.relatedParties || []).map(id => ({ id, name: orgName(state, id) }))
    },
    disclosures: state.disclosures.filter(d => d.engagementId === engagement.id).map(d => ({
      ...d,
      grants: grants.filter(g => g.disclosureId === d.id).map(g => ({
        ...g,
        firmName: orgName(state, g.firmId),
        memberNames: g.memberIds.map(id => memberName(state, id)),
        delivery: deliveryProgress(state, g.id)
      }))
    })),
    grants: grants.map(g => ({
      ...g,
      firmName: orgName(state, g.firmId),
      memberNames: g.memberIds.map(id => memberName(state, id)),
      delivery: deliveryProgress(state, g.id)
    })),
    commissions: state.commissions.filter(c => c.engagementId === engagement.id),
    workProducts: state.workProducts.filter(w => w.engagementId === engagement.id),
    handoffs: state.handoffs.filter(h => h.engagementId === engagement.id).map(h => ({
      ...h,
      completed: h.status === 'completed',
      fromFirmName: orgName(state, h.fromFirmId),
      toFirmName: orgName(state, h.toFirmId)
    })),
    disputes: state.disputes.filter(d => d.engagementId === engagement.id),
    team: state.teamMemberships.filter(t => t.engagementId === engagement.id)
  };
}

function redactedScreening(state, screening, actor) {
  const firmId = actor.firm;
  return {
    id: screening.id,
    engagementId: screening.engagementId,
    status: screening.status,
    members: screening.members
      .filter(m => findById(state.members, m.memberId)?.firm === firmId)
      .map(m => ({
        memberId: m.memberId,
        reviewRequired: m.check === 'manual_review_required',
        reviewState: memberConflictState(state, screening.engagementId, m.memberId).blocking ? 'action_required' : 'clear_or_waived'
      })),
    limitedBasis: screening.decline?.limitedBasis ?? null
  };
}

export function adviserEngagementView(state, engagement, actor) {
  const firmId = actor.firm;
  const memberId = actor.member;
  const myTeam = state.teamMemberships.filter(t => t.engagementId === engagement.id && t.firmId === firmId);
  const myInquiries = state.inquiries.filter(i => i.engagementId === engagement.id && i.firmId === firmId);
  const involved = myTeam.length || myInquiries.length ||
    state.screenings.some(s => s.engagementId === engagement.id && s.firmId === firmId) ||
    state.ndas.some(n => n.engagementId === engagement.id && n.firmId === firmId) ||
    state.grants.some(g => g.engagementId === engagement.id && (g.firmId === firmId || state.subcontracts.some(sc => sc.subcontractorFirmId === firmId))) ||
    state.handoffs.some(h => h.engagementId === engagement.id && h.toFirmId === firmId) ||
    state.workProducts.some(w => w.engagementId === engagement.id && w.originFirmId === firmId);
  if (!involved) return null;
  const myGrants = state.grants.filter(g => g.engagementId === engagement.id && (g.firmId === firmId ? g.memberIds.includes(memberId) : false));
  const grantedDocIds = new Set(myGrants.map(g => g.documentId));
  return {
    id: engagement.id,
    reference: `BLIND-${engagement.id}`,
    areas: engagement.areas,
    materialScope: (engagement.materialScope || []).map(x => typeof x === 'string' ? { category: x } : { category: x.category, description: x.description }),
    stage: engagement.stage,
    bottleneck: bottleneck(state, engagement).code,
    myTeam,
    myInquiries: myInquiries.map(i => ({ id: i.id, status: i.status, createdAt: i.createdAt })),
    myScreenings: state.screenings
      .filter(s => s.engagementId === engagement.id && s.firmId === firmId)
      .map(s => redactedScreening(state, s, actor)),
    myNdas: state.ndas.filter(n => n.engagementId === engagement.id && n.firmId === firmId).map(n => ({
      id: n.id, status: n.status, memberIds: n.memberIds, effective: n.status === 'effective'
    })),
    myDisclosureScopes: myGrants.map(g => ({
      id: g.id,
      documentId: g.documentId,
      version: g.version,
      sections: g.sections,
      purposes: g.purposes,
      allowSubcontracting: g.allowSubcontracting,
      status: g.status
    })),
    documents: state.documents.filter(d => grantedDocIds.has(d.id)).map(d => ({
      id: d.id, version: d.version, familyId: d.familyId, sections: d.sections, sizeBytes: d.sizeBytes
    })),
    myCommissions: state.commissions.filter(c => c.engagementId === engagement.id && c.firmId === firmId && c.memberIds.includes(memberId)),
    myWorkProducts: state.workProducts.filter(w => w.engagementId === engagement.id && w.originFirmId === firmId),
    incomingHandoffs: state.handoffs.filter(h => h.engagementId === engagement.id && h.toFirmId === firmId).map(h => ({
      id: h.id, status: h.status, memberIds: h.memberIds, items: h.items
    }))
  };
}

export function adviserInquiryView(state, inquiry, actor) {
  const engagement = findById(state.engagements, inquiry.engagementId);
  return {
    id: inquiry.id,
    engagementId: engagement.id,
    blindReference: `BLIND-${engagement.id}`,
    areas: engagement.areas,
    materialScope: engagement.materialScope,
    requiredMembers: inquiry.requiredMembers ?? null,
    status: inquiry.status,
    createdAt: inquiry.createdAt
  };
}
