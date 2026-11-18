const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createDb } = require('../src/db');
const { createApp } = require('../src/server');

async function startTestServer() {
  const config = {
    port: 0,
    nodeEnv: 'test',
    isProd: false,
    appTitle: 'Test Work Ledger',
    sessionSecret: 'test-secret-key-for-automated-suite',
    databaseUrl: '',
    sqlitePath: ':memory:',
    bossName: '',
    bossEmail: '',
    bossPassword: '',
    teamInviteCode: 'INVITE-2026',
  };

  const db = await createDb(config);
  const app = createApp(db, config);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
  }

  async request(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }

    const contentType = res.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await res.json()
      : await res.text();

    return { status: res.status, body };
  }
}

test('Full isolation, multi-entry logging, and executive oversight', async () => {
  const srv = await startTestServer();

  try {
    const boss = new Client(srv.baseUrl);
    const empA = new Client(srv.baseUrl);
    const empB = new Client(srv.baseUrl);
    const anon = new Client(srv.baseUrl);

    // 1. Health & initial boss setup check
    const health = await anon.request('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const statusBefore = await anon.request('/api/auth/status');
    assert.equal(statusBefore.body.needsBossSetup, true);
    assert.equal(statusBefore.body.authenticated, false);

    // 2. Setup boss once; second attempt must fail with 403
    const bossSetup = await boss.request('/api/auth/setup-boss', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Sarah Director',
        email: 'sarah@mjx.local',
        password: 'BossPassword123',
      }),
    });
    assert.equal(bossSetup.status, 201);
    assert.equal(bossSetup.body.user.role, 'boss');

    const secondSetup = await anon.request('/api/auth/setup-boss', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Fake Boss',
        email: 'fake@mjx.local',
        password: 'FakePassword123',
      }),
    });
    assert.equal(secondSetup.status, 403);

    // 3. Employee registration requires valid invite code
    const badReg = await empA.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Alice Intern',
        email: 'alice@mjx.local',
        password: 'AlicePassword1',
        inviteCode: 'WRONG-CODE',
      }),
    });
    assert.equal(badReg.status, 403);

    const regA = await empA.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Alice Intern',
        email: 'alice@mjx.local',
        password: 'AlicePassword1',
        inviteCode: 'INVITE-2026',
      }),
    });
    assert.equal(regA.status, 201);
    assert.equal(regA.body.user.role, 'employee');

    const regB = await empB.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bob Intern',
        email: 'bob@mjx.local',
        password: 'BobPassword1',
        inviteCode: 'INVITE-2026',
      }),
    });
    assert.equal(regB.status, 201);

    // 4. Multiple entries per day with 4 fields
    const logA1 = await empA.request('/api/logs', {
      method: 'POST',
      body: JSON.stringify({
        project: 'Alpha CRM',
        workDone: 'Implemented OAuth callback handler',
      }),
    });
    assert.equal(logA1.status, 201);
    assert.equal(logA1.body.log.personName, 'Alice Intern');
    assert.equal(logA1.body.log.project, 'Alpha CRM');
    assert.equal(logA1.body.log.workDone, 'Implemented OAuth callback handler');
    assert.ok(Date.parse(logA1.body.log.loggedAt));

    const logA2 = await empA.request('/api/logs', {
      method: 'POST',
      body: JSON.stringify({
        project: 'Alpha CRM',
        workDone: 'Added unit tests for token refresh',
      }),
    });
    assert.equal(logA2.status, 201);

    const logB1 = await empB.request('/api/logs', {
      method: 'POST',
      body: JSON.stringify({
        project: 'Beta Analytics',
        workDone: 'Built revenue cohort SQL view',
      }),
    });
    assert.equal(logB1.status, 201);

    // 5. Strict Employee Isolation checks
    const aLogs = await empA.request(`/api/logs?userId=${regB.body.user.id}`);
    assert.equal(aLogs.status, 200);
    assert.equal(aLogs.body.logs.length, 2);
    assert.deepEqual(aLogs.body.projects, ['Alpha CRM']);
    assert.equal(aLogs.body.employees, undefined);
    const serializedA = JSON.stringify(aLogs.body);
    assert.equal(serializedA.includes('Bob Intern'), false);
    assert.equal(serializedA.includes('Beta Analytics'), false);
    assert.equal(serializedA.includes('revenue cohort'), false);

    // Employee A cannot edit or delete Employee B's entry (must get 404, not 403)
    const patchOther = await empA.request(`/api/logs/${logB1.body.log.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ project: 'Hacked', workDone: 'Hacked' }),
    });
    assert.equal(patchOther.status, 404);

    const delOther = await empA.request(`/api/logs/${logB1.body.log.id}`, {
      method: 'DELETE',
    });
    assert.equal(delOther.status, 404);

    // Employee A CSV export ignores userId filter and contains only Alice's entries
    const csvA = await empA.request(`/api/logs/export.csv?userId=${regB.body.user.id}`);
    assert.equal(csvA.status, 200);
    assert.equal(csvA.body.includes('Alice Intern'), true);
    assert.equal(csvA.body.includes('Bob Intern'), false);

    // Employee A cannot hit any Boss endpoints
    assert.equal((await empA.request('/api/boss/team')).status, 403);
    assert.equal(
      (
        await empA.request('/api/boss/invite-code', {
          method: 'PUT',
          body: JSON.stringify({ inviteCode: 'NEW-1234' }),
        })
      ).status,
      403
    );

    // 6. Boss sees everyone's details and history
    const bossLogs = await boss.request('/api/logs');
    assert.equal(bossLogs.status, 200);
    assert.equal(bossLogs.body.logs.length, 3);
    assert.equal(bossLogs.body.employees.length, 2);
    assert.equal(bossLogs.body.stats.activeContributorsToday, 2);

    // Boss filters by Bob
    const bossBobLogs = await boss.request(`/api/logs?userId=${regB.body.user.id}`);
    assert.equal(bossBobLogs.status, 200);
    assert.equal(bossBobLogs.body.logs.length, 1);
    assert.equal(bossBobLogs.body.logs[0].personName, 'Bob Intern');

    // Boss CSV export includes both
    const bossCsv = await boss.request('/api/logs/export.csv');
    assert.equal(bossCsv.status, 200);
    assert.equal(bossCsv.body.includes('Alice Intern'), true);
    assert.equal(bossCsv.body.includes('Bob Intern'), true);

    // 7. Boss deactivates Alice -> Alice's session immediately revoked
    const deactivate = await boss.request(`/api/boss/team/${regA.body.user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    });
    assert.equal(deactivate.status, 200);

    const aAfterDeactivate = await empA.request('/api/logs');
    assert.equal(aAfterDeactivate.status, 401);

    // 8. Boss resets Bob's password -> Bob's old session invalidated, new password works
    const resetBob = await boss.request(`/api/boss/team/${regB.body.user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ password: 'NewBobPassword99' }),
    });
    assert.equal(resetBob.status, 200);

    assert.equal((await empB.request('/api/logs')).status, 401);

    const bobRelogin = await empB.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'bob@mjx.local',
        password: 'NewBobPassword99',
      }),
    });
    assert.equal(bobRelogin.status, 200);
    assert.equal((await empB.request('/api/logs')).body.logs.length, 1);

    // 9. Forgot password request requires invite code, does not leak email existence, and flags boss
    const forgotWrongCode = await anon.request('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'bob@mjx.local', inviteCode: 'BAD' }),
    });
    assert.equal(forgotWrongCode.status, 403);

    const forgotUnknown = await anon.request('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@mjx.local', inviteCode: 'INVITE-2026' }),
    });
    assert.equal(forgotUnknown.status, 200);

    const forgotBob = await anon.request('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'bob@mjx.local', inviteCode: 'INVITE-2026' }),
    });
    assert.equal(forgotBob.status, 200);

    const teamWithFlag = await boss.request('/api/boss/team');
    const bobMember = teamWithFlag.body.members.find((m) => m.email === 'bob@mjx.local');
    assert.ok(bobMember.resetRequestedAt);

    // 10. Self-service change password updates hash, clears flag, and keeps caller signed in
    const badChange = await empB.request('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'BrandNewPassword1' }),
    });
    assert.equal(badChange.status, 401);

    const goodChange = await empB.request('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: 'NewBobPassword99',
        newPassword: 'BrandNewPassword1',
      }),
    });
    assert.equal(goodChange.status, 200);
    assert.equal((await empB.request('/api/logs')).status, 200);

    const teamCleared = await boss.request('/api/boss/team');
    const bobCleared = teamCleared.body.members.find((m) => m.email === 'bob@mjx.local');
    assert.equal(bobCleared.resetRequestedAt, null);
  } finally {
    await srv.close();
  }
});
