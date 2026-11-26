import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeer } from '../support/peer.mjs';
import { createBusinessServer } from '../support/app.mjs';
import { partnerConfig } from '../support/store.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));

async function stack(appOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'adviser-room-'));
  const peer = createPeer(partnerConfig, join(dir, 'partner.json'));
  const partnerUrl = await listen(peer);
  const app = createBusinessServer({
    stateFile: join(dir, 'app.json'),
    localObjectDir: join(dir, 'objects'),
    partnerUrl,
    segmentSize: 1024,
    streamChunkBytes: 128,
    ...appOptions
  });
  const base = await listen(app.server);
  return {
    dir, peer, app, base, partnerUrl,
    async stop() {
      await close(app.server);
      await close(peer);
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function req(base, actorId, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (actorId) headers['x-actor-id'] = actorId;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* text range */ }
  return { status: response.status, json, text, headers: response.headers };
}

async function confirmNda(s, ndaId, actor = 'secretary') {
  const nda = s.app.store.state.ndas.find(n => n.id === ndaId);
  for (const signer of nda.signerRefs) {
    const result = await req(s.partnerUrl, null, '/control/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { id: signer.ref, status: 'confirmed', details: { provider: 'synthetic' } }
    });
    assert.equal(result.status, 200, result.text);
  }
  const notified = await req(s.base, actor, `/api/ndas/${ndaId}/notifications`, {
    body: { providerEvent: 'confirmed', memberIds: ['USER-INTRUDER'] }
  });
  assert.equal(notified.status, 200);
  assert.equal(notified.json.scopeExpanded, false);
  assert.deepEqual(notified.json.nda.memberIds, nda.memberIds);
  assert.equal(notified.json.effective, true);
  return notified.json.nda;
}

async function onboardCleanMember(s, engagementId, {
  actor = 'adviser-a', memberId = 'USER-A', firmId = 'ADV-A', inquiry = true, sections = ['commercial'], purposes = ['quote'], commission = false
} = {}) {
  if (inquiry) {
    const inquiryRes = await req(s.base, 'secretary', `/api/engagements/${engagementId}/inquiries`, { body: { firmIds: [firmId] } });
    assert.equal(inquiryRes.status, 201, inquiryRes.text);
  }
  const teamRes = await req(s.base, 'secretary', `/api/engagements/${engagementId}/team-members`, { body: { memberId, firmId } });
  assert.equal(teamRes.status, 201, teamRes.text);
  const screen = await req(s.base, actor, `/api/engagements/${engagementId}/screenings`, { body: { memberIds: [memberId] } });
  assert.equal(screen.status, 201, screen.text);
  assert.equal(screen.json.screening.status, 'clear');
  const ndaRes = await req(s.base, actor, `/api/engagements/${engagementId}/ndas`, { body: { memberIds: [memberId] } });
  assert.equal(ndaRes.status, 202, ndaRes.text);
  assert.notEqual(ndaRes.json.effective, true);
  await confirmNda(s, ndaRes.json.nda.id);
  const disclosure = await req(s.base, 'client', `/api/engagements/${engagementId}/disclosures`, {
    body: { firmId, memberIds: [memberId], items: [{ documentId: 'DOC-1', sections, purposes }] }
  });
  assert.equal(disclosure.status, 201, disclosure.text);
  let commissionRes = null;
  if (commission) {
    commissionRes = await req(s.base, 'client', `/api/engagements/${engagementId}/commission`, { body: { firmId, memberIds: [memberId] } });
    assert.equal(commissionRes.status, 201, commissionRes.text);
  }
  return { disclosure: disclosure.json, commission: commissionRes?.json?.commission ?? null };
}

test('秘书处、企业和顾问看到不同范围；冲突拒绝不泄露其他企业名单', async () => {
  const s = await stack();
  try {
    const inquiry = await req(s.base, 'secretary', '/api/engagements/ENG-1/inquiries', { body: { firmIds: ['ADV-A'] } });
    assert.equal(inquiry.status, 201);

    const hit = await req(s.base, 'adviser-b', '/api/engagements/ENG-1/screenings', { body: { memberIds: ['USER-B'] } });
    assert.equal(hit.status, 201);
    assert.equal(hit.json.screening.members[0].reviewRequired, true);
    const adviserText = JSON.stringify(hit.json);
    assert.ok(!adviserText.includes('ORG-B'));
    assert.ok(!adviserText.includes('合成企业乙'));
    assert.ok(!adviserText.includes('合成保密其他客户丙'));
    assert.ok(!adviserText.includes('SECRET-ROSTER-1'));

    const declined = await req(s.base, 'adviser-b', `/api/screenings/${hit.json.screening.id}/decline`, { body: {} });
    assert.equal(declined.status, 200);
    assert.deepEqual(Object.keys(declined.json.retainedBasis).sort(), ['code', 'requiresManualReview', 'screeningId', 'retainedAt'].sort());
    const adviserView = await req(s.base, 'adviser-b', `/api/screenings/${hit.json.screening.id}`);
    assert.ok(!JSON.stringify(adviserView.json).includes('ORG-D'));

    const secretary = await req(s.base, 'secretary', '/api/secretary/engagements');
    assert.equal(secretary.status, 200);
    const eng1 = secretary.json.engagements.find(e => e.id === 'ENG-1');
    assert.equal(eng1.bottleneck.code, 'screening');
    assert.ok(eng1.screenings[0].members[0].matches.length >= 1);

    const clientList = await req(s.base, 'client', '/api/client/engagements');
    assert.equal(clientList.status, 200);
    assert.ok(clientList.json.engagements.some(e => e.id === 'ENG-1'));
    const adviserList = await req(s.base, 'adviser-successor', '/api/adviser/engagements');
    assert.equal(adviserList.status, 200);
    assert.equal(adviserList.json.engagements.length, 0);
  } finally { await s.stop(); }
});

test('确认冲突后必须双方书面豁免；秘书处不能替企业披露', async () => {
  const s = await stack();
  try {
    await req(s.base, 'secretary', '/api/engagements/ENG-1/inquiries', { body: { firmIds: ['ADV-A'] } });
    await req(s.base, 'secretary', '/api/engagements/ENG-1/team-members', { body: { memberId: 'USER-B', firmId: 'ADV-A' } });
    const screen = await req(s.base, 'adviser-b', '/api/engagements/ENG-1/screenings', { body: { memberIds: ['USER-B'] } });
    const screenId = screen.json.screening.id;
    const review = await req(s.base, 'secretary', `/api/screenings/${screenId}/review`, { body: { memberId: 'USER-B', outcome: 'conflict_confirmed' } });
    assert.equal(review.status, 200);

    const blockedNda = await req(s.base, 'adviser-b', '/api/engagements/ENG-1/ndas', { body: { memberIds: ['USER-B'] } });
    assert.equal(blockedNda.status, 409);
    await req(s.base, 'client', `/api/screenings/${screenId}/waivers`, { body: { party: 'client', writingRef: 'WAIVER-CLIENT-SYNTH' } });
    const oneSideNda = await req(s.base, 'adviser-b', '/api/engagements/ENG-1/ndas', { body: { memberIds: ['USER-B'] } });
    assert.equal(oneSideNda.status, 409);
    await req(s.base, 'counterparty-b', `/api/screenings/${screenId}/waivers`, { body: { party: 'counterparty', writingRef: 'WAIVER-COUNTER-SYNTH' } });

    const nda = await req(s.base, 'adviser-b', '/api/engagements/ENG-1/ndas', { body: { memberIds: ['USER-B'] } });
    assert.equal(nda.status, 202, nda.text);
    await confirmNda(s, nda.json.nda.id, 'adviser-b');

    const secretaryConsent = await req(s.base, 'secretary', '/api/engagements/ENG-1/disclosures', {
      body: { firmId: 'ADV-A', memberIds: ['USER-B'], items: [{ documentId: 'DOC-1', sections: ['commercial'], purposes: ['quote'] }] }
    });
    assert.equal(secretaryConsent.status, 403);
    const clientConsent = await req(s.base, 'client', '/api/engagements/ENG-1/disclosures', {
      body: { firmId: 'ADV-A', memberIds: ['USER-B'], items: [{ documentId: 'DOC-1', sections: ['commercial'], purposes: ['quote'] }] }
    });
    assert.equal(clientConsent.status, 201, clientConsent.text);
  } finally { await s.stop(); }
});

test('电子签署受理不等于生效；重复通知不扩张人员，文件按版本章节用途和续传实时鉴权', async () => {
  const s = await stack();
  try {
    await onboardCleanMember(s, 'ENG-1', { sections: ['commercial'], purposes: ['quote'] });
    const grantId = s.app.store.state.grants.at(-1).id;

    const beforeConfirmAccess = await req(s.base, 'adviser-a', `/api/documents/DOC-1/content?engagementId=ENG-1&purpose=quote&section=commercial`);
    // onboard 已确认 NDA，因此这里应为 200；未生效窗口在 onboard 内部已断言。
    assert.equal(beforeConfirmAccess.status, 200);

    const segment0 = await req(s.base, 'adviser-a', `/api/engagements/ENG-1/documents/DOC-1/segments/0/content?purpose=quote&section=commercial`);
    assert.equal(segment0.status, 200);
    assert.equal(Buffer.byteLength(segment0.text), 1024);

    const technical = await req(s.base, 'adviser-a', `/api/documents/DOC-1/content?engagementId=ENG-1&purpose=quote&section=technical`);
    assert.equal(technical.status, 403);
    assert.equal(technical.json.code, 'DISCLOSURE_SCOPE_DENIED');

    const perform = await req(s.base, 'adviser-a', `/api/documents/DOC-1/content?engagementId=ENG-1&purpose=perform&section=commercial`);
    assert.equal(perform.status, 403);

    const newVersion = await req(s.base, 'adviser-a', `/api/documents/DOC-1/content?version=2&engagementId=ENG-1&purpose=quote&section=commercial`);
    assert.equal(newVersion.status, 403);

    const crossing = await fetch(`${s.base}/api/documents/DOC-1/content?engagementId=ENG-1&purpose=quote`, {
      headers: { 'x-actor-id': 'adviser-a', Range: 'bytes=9000-9300' }
    });
    assert.equal(crossing.status, 403);
    await crossing.body?.cancel();

    await req(s.base, 'client', `/api/disclosures/${grantId}/revoke`, { body: { reason: 'test revoke' } });
    const nextSegment = await req(s.base, 'adviser-a', `/api/engagements/ENG-1/documents/DOC-1/segments/1/content?purpose=quote&section=commercial`);
    assert.equal(nextSegment.status, 403);
    const resume = await fetch(`${s.base}/api/documents/DOC-1/content?engagementId=ENG-1&purpose=quote&section=commercial`, {
      headers: { 'x-actor-id': 'adviser-a', Range: 'bytes=1024-2047' }
    });
    assert.equal(resume.status, 403);
    await resume.body?.cancel();

    const delivery = await req(s.base, 'client', `/api/disclosures/${grantId}/delivery`);
    assert.equal(delivery.status, 200);
    assert.ok(delivery.json.delivery.downloadedBytes >= 1024);
    assert.ok(delivery.json.delivery.downloadedRanges.length >= 1);
  } finally { await s.stop(); }
});

test('同一个长下载进行中撤权后，后续内存分块停止且新分段被拒', async () => {
  let enterGate;
  const gateEntered = new Promise(resolve => { enterGate = resolve; });
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  let gated = false;
  const s = await stack({
    hooks: {
      beforeChunk: async ({ chunkIndex }) => {
        if (chunkIndex === 4 && !gated) {
          gated = true;
          enterGate();
          await gate;
        }
      }
    }
  });
  try {
    await onboardCleanMember(s, 'ENG-1', { sections: ['commercial'], purposes: ['quote'] });
    const largeGrant = await req(s.base, 'client', '/api/engagements/ENG-1/disclosures', {
      body: { firmId: 'ADV-A', memberIds: ['USER-A'], items: [{ documentId: 'DOC-LARGE-SYNTH', sections: ['general'], purposes: ['quote'] }] }
    });
    assert.equal(largeGrant.status, 201, largeGrant.text);
    const grantId = largeGrant.json.grants[0].id;
    const response = await fetch(`${s.base}/api/documents/DOC-LARGE-SYNTH/content?engagementId=ENG-1&purpose=quote&section=general`, {
      headers: { 'x-actor-id': 'adviser-a' }
    });
    assert.equal(response.status, 200);
    await gateEntered;
    const revoke = await req(s.base, 'client', `/api/disclosures/${grantId}/revoke`, { body: { reason: 'revoke-while-downloading' } });
    assert.equal(revoke.status, 200);
    releaseGate();

    let received = 0;
    let streamFailed = false;
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
      }
    } catch {
      streamFailed = true;
    }
    assert.ok(streamFailed || received < 262144, `长响应应在撤权后截断，实际收到 ${received} 字节`);

    const laterSegment = await req(s.base, 'adviser-a', '/api/engagements/ENG-1/documents/DOC-LARGE-SYNTH/segments/200/content?purpose=quote&section=general');
    assert.equal(laterSegment.status, 403);
    const progress = await req(s.base, 'client', `/api/disclosures/${grantId}/delivery`);
    assert.ok(progress.json.delivery.eventCount >= 1);
  } finally { releaseGate?.(); await s.stop(); }
});

test('成员更换后旧成员后续分段立即拒绝，新成员不自动获得授权', async () => {
  const s = await stack();
  try {
    await req(s.base, 'client', '/api/engagements', { body: { id: 'ENG-RACE', counterparties: ['ORG-B'], areas: ['legal'], materialScope: ['commercial'] } });
    await onboardCleanMember(s, 'ENG-RACE', { memberId: 'USER-C', actor: 'adviser-c' });
    const first = await req(s.base, 'adviser-c', '/api/engagements/ENG-RACE/documents/DOC-1/segments/0/content?purpose=quote&section=commercial');
    assert.equal(first.status, 200);

    const replaced = await req(s.base, 'secretary', '/api/engagements/ENG-RACE/replace-member', {
      body: { oldMemberId: 'USER-C', newMemberId: 'USER-NEW', newMemberName: '合成新人员' }
    });
    assert.equal(replaced.status, 200);
    assert.ok(replaced.json.newActorId);

    const later = await req(s.base, 'adviser-c', '/api/engagements/ENG-RACE/documents/DOC-1/segments/1/content?purpose=quote&section=commercial');
    assert.equal(later.status, 403);
    assert.equal(later.json.code, 'TEAM_MEMBER_INACTIVE');

    const newActorAccess = await req(s.base, replaced.json.newActorId, '/api/engagements/ENG-RACE');
    assert.equal(newActorAccess.status, 200);
    const newFile = await req(s.base, replaced.json.newActorId, '/api/documents/DOC-1/content?engagementId=ENG-RACE&purpose=quote&section=commercial');
    assert.equal(newFile.status, 403);
    assert.equal(newFile.json.code, 'NDA_NOT_EFFECTIVE');
  } finally { await s.stop(); }
});

test('成员更换、续传和交接并发提交后状态仍可线性核对', async () => {
  const s = await stack();
  try {
    await req(s.base, 'client', '/api/engagements', { body: { id: 'ENG-CONC', counterparties: ['ORG-B'], areas: ['legal'] } });
    await onboardCleanMember(s, 'ENG-CONC', { memberId: 'USER-C', actor: 'adviser-c' });

    const responses = await Promise.allSettled([
      req(s.base, 'secretary', '/api/engagements/ENG-CONC/replace-member', { body: { oldMemberId: 'USER-C', newMemberId: 'USER-PARALLEL' } }),
      req(s.base, 'adviser-c', '/api/engagements/ENG-CONC/documents/DOC-1/segments/1/content?purpose=quote&section=commercial'),
      req(s.base, 'adviser-c', '/api/documents/DOC-1/content?engagementId=ENG-CONC&purpose=quote&section=commercial', { headers: { Range: 'bytes=2048-3071' } }),
      req(s.base, 'secretary', '/api/engagements/ENG-CONC/handoffs', { body: { toFirmId: 'ADV-B', memberIds: ['USER-S'], documentIds: ['DOC-1'] } })
    ]);
    for (const item of responses) {
      if (item.status === 'fulfilled') assert.notEqual(item.value.status, 500, item.value.text);
    }
    const after = await req(s.base, 'adviser-c', '/api/engagements/ENG-CONC/documents/DOC-1/segments/2/content?purpose=quote&section=commercial');
    assert.equal(after.status, 403);
    const summary = await req(s.base, 'secretary', '/api/dev/state-summary');
    assert.equal(summary.status, 200);
    assert.ok(summary.json.counts.handoffs >= 1);
    assert.ok(s.app.store.state.teamMemberships.some(t => t.engagementId === 'ENG-CONC' && t.memberId === 'USER-PARALLEL'));
  } finally { await s.stop(); }
});

test('交接清单不等于成果授权；逐项企业同意、前任放行、费用争议和委托状态可核对', async () => {
  const s = await stack();
  try {
    await req(s.base, 'client', '/api/engagements', { body: { id: 'ENG-HO', counterparties: ['ORG-B'], areas: ['legal', 'accounting'] } });
    await onboardCleanMember(s, 'ENG-HO', { sections: ['commercial', 'technical'], purposes: ['quote', 'perform'], commission: true });

    const wp1 = await req(s.base, 'adviser-a', '/api/engagements/ENG-HO/work-products', {
      body: { draftId: 'WP-1', title: '可按企业批准转交的成果', content: 'WP1 synthetic', citations: [{ documentId: 'DOC-1' }] }
    });
    assert.equal(wp1.status, 201, wp1.text);
    const wp2 = await req(s.base, 'adviser-a', '/api/engagements/ENG-HO/work-products', {
      body: { title: '前任专有方法成果', content: 'WP2 synthetic', citations: [{ documentId: 'DOC-1', version: 1 }] }
    });
    assert.equal(wp2.status, 201, wp2.text);
    await req(s.base, 'client', `/api/work-products/${wp1.json.workProduct.id}/accept`, { body: { partial: true, acceptedParts: ['first-section'] } });

    await req(s.base, 'secretary', '/api/engagements/ENG-HO/inquiries', { body: { firmIds: ['ADV-B'] } });
    const screenS = await req(s.base, 'adviser-successor', '/api/engagements/ENG-HO/screenings', { body: { memberIds: ['USER-S'] } });
    assert.equal(screenS.status, 201);
    const teamS = await req(s.base, 'secretary', '/api/engagements/ENG-HO/team-members', { body: { memberId: 'USER-S', firmId: 'ADV-B' } });
    assert.equal(teamS.status, 201, teamS.text);
    const ndaS = await req(s.base, 'adviser-successor', '/api/engagements/ENG-HO/ndas', { body: { memberIds: ['USER-S'] } });
    assert.equal(ndaS.status, 202, ndaS.text);
    await confirmNda(s, ndaS.json.nda.id, 'adviser-successor');

    const handoff = await req(s.base, 'secretary', '/api/engagements/ENG-HO/handoffs', {
      body: { toFirmId: 'ADV-B', memberIds: ['USER-S'], workProductIds: [wp1.json.workProduct.id, wp2.json.workProduct.id], documentIds: ['DOC-1'] }
    });
    assert.equal(handoff.status, 201, handoff.text);
    const hoId = handoff.json.handoff.id;

    const beforeListRight = await req(s.base, 'adviser-successor', `/api/work-products/${wp1.json.workProduct.id}/content`);
    assert.equal(beforeListRight.status, 403);

    const approval = await req(s.base, 'client', `/api/handoffs/${hoId}/client-approval`, {
      body: {
        workProductIds: [wp1.json.workProduct.id, wp2.json.workProduct.id],
        documentGrants: [{ documentId: 'DOC-1', sections: ['commercial'], purposes: ['perform'] }]
      }
    });
    assert.equal(approval.status, 200, approval.text);

    const wp1AfterApproval = await req(s.base, 'adviser-successor', `/api/work-products/${wp1.json.workProduct.id}/content`);
    assert.equal(wp1AfterApproval.status, 200);
    const wp2MissingRelease = await req(s.base, 'adviser-successor', `/api/work-products/${wp2.json.workProduct.id}/content`);
    assert.equal(wp2MissingRelease.status, 403);
    assert.equal(wp2MissingRelease.json.code, 'WORK_TRANSFER_NOT_AUTHORIZED');

    const release = await req(s.base, 'adviser-a', `/api/handoffs/${hoId}/release`, { body: { workProductIds: [wp2.json.workProduct.id] } });
    assert.equal(release.status, 200);
    const wp2AfterRelease = await req(s.base, 'adviser-successor', `/api/work-products/${wp2.json.workProduct.id}/content`);
    assert.equal(wp2AfterRelease.status, 200);

    const dispute = await req(s.base, 'adviser-a', '/api/engagements/ENG-HO/disputes', { body: { invoiceRef: 'INV-SYNTH-1', amount: 100, note: '虚构未结费用争议' } });
    assert.equal(dispute.status, 201);
    const revoke = await req(s.base, 'client', '/api/engagements/ENG-HO/revoke-materials', { body: { memberId: 'USER-A', reason: '更换顾问并撤回前任原始资料' } });
    assert.equal(revoke.status, 200);
    assert.ok(revoke.json.revokedGrants >= 1);
    const predecessorDoc = await req(s.base, 'adviser-a', '/api/documents/DOC-1/content?engagementId=ENG-HO&purpose=perform&section=commercial');
    assert.equal(predecessorDoc.status, 403);
    const predecessorOwnWork = await req(s.base, 'adviser-a', `/api/work-products/${wp1.json.workProduct.id}/content`);
    assert.equal(predecessorOwnWork.status, 200);

    const successorCommission = await req(s.base, 'client', `/api/engagements/ENG-HO/commission`, { body: { firmId: 'ADV-B', memberIds: ['USER-S'] } });
    assert.equal(successorCommission.status, 201, successorCommission.text);
    const accept = await req(s.base, 'adviser-successor', `/api/handoffs/${hoId}/accept`, { body: {} });
    assert.equal(accept.status, 200, accept.text);
    const complete = await req(s.base, 'client', `/api/handoffs/${hoId}/complete`, { body: {} });
    assert.equal(complete.status, 200, complete.text);
    const dashboard = await req(s.base, 'client', '/api/client/engagements');
    const eng = dashboard.json.engagements.find(e => e.id === 'ENG-HO');
    assert.equal(eng.handoffs[0].completed, true);
    assert.ok(eng.commissions.some(c => c.firmId === 'ADV-B' && c.status === 'active'));
    assert.ok(eng.disputes.length, 1);
    assert.ok(eng.grants.some(g => g.firmId === 'ADV-B' && g.version === 1));
  } finally { await s.stop(); }
});
