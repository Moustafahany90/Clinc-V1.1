/**
 * Comprehensive verification script for:
 * 1. Token invalidation on logout (JWT Blacklist)
 * 2. Session management endpoints (GET /sessions, GET /admin/sessions, DELETE /sessions/:id)
 * 3. Clinician report print-data flow and RBAC scoping
 * 4. Standardized error handling format across routes
 * 5. Forced password change flow (mustChangePassword)
 *
 * Run with:
 *   node backend/tests/verify-all.mjs [baseUrl]
 */

import { randomUUID } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:8080/api/v1';

const PASSWORD = process.env.TEST_PASSWORD;
const TEMP_PASSWORD = process.env.TEMP_PASSWORD;
if (!PASSWORD || !TEMP_PASSWORD) {
  throw new Error('Set TEST_PASSWORD and TEMP_PASSWORD to the passwords used when seeding test accounts.');
}

let passed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  [ok]   ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${extra ? ` -> ${JSON.stringify(extra)}` : ''}`);
  }
}

function makeClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    set cookie(val) {
      cookie = val;
    },
    async call(method, path, { body, token } = {}) {
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      if (cookie) headers.cookie = cookie;
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.getSetCookie?.() ?? [];
      for (const entry of setCookie) {
        const pair = entry.split(';')[0];
        if (pair.startsWith('uc_refresh=')) cookie = pair;
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: res.status, data };
    },
  };
}

async function run() {
  console.log(`\n======================================================`);
  console.log(`End-to-End Verification Suite against ${BASE}`);
  console.log(`======================================================\n`);

  const adminClient = makeClient();
  const doctorClient = makeClient();
  const doctor2Client = makeClient();
  const receptionClient = makeClient();
  const tempUserClient = makeClient();

  // 1. Health checks & error standardization
  console.log('--- 1. Health Checks & Error Handling ---');
  const health = await adminClient.call('GET', '/health');
  check('GET /health returns ok', health.status === 200 && health.data.status === 'ok', health.data);

  const healthDb = await adminClient.call('GET', '/health/db');
  check('GET /health/db returns reachable', healthDb.status === 200 && healthDb.data.database === 'reachable', healthDb.data);

  const notFound = await adminClient.call('GET', '/non-existent-route-xyz');
  check(
    '404 route returns standardized { error: { code, message } }',
    notFound.status === 404 && notFound.data?.error?.code === 'NOT_FOUND',
    notFound.data,
  );

  // 2. Authentication for all seeded roles
  console.log('\n--- 2. Role Authentication ---');
  const adminLogin = await adminClient.call('POST', '/auth/login', {
    body: { email: 'admin@ultrasound.clinic', password: PASSWORD },
  });
  check('Admin login succeeds', adminLogin.status === 200 && adminLogin.data.user.role === 'ADMIN', adminLogin.data);
  const adminToken = adminLogin.data?.accessToken;

  const docLogin = await doctorClient.call('POST', '/auth/login', {
    body: { email: 'doctor@ultrasound.clinic', password: PASSWORD },
  });
  check('Doctor login succeeds', docLogin.status === 200 && docLogin.data.user.role === 'DOCTOR', docLogin.data);
  const doctorToken = docLogin.data?.accessToken;

  const doc2Login = await doctor2Client.call('POST', '/auth/login', {
    body: { email: 'doctor2@ultrasound.clinic', password: PASSWORD },
  });
  check('Doctor2 login succeeds', doc2Login.status === 200 && doc2Login.data.user.role === 'DOCTOR', doc2Login.data);
  const doctor2Token = doc2Login.data?.accessToken;

  const recLogin = await receptionClient.call('POST', '/auth/login', {
    body: { email: 'reception@ultrasound.clinic', password: PASSWORD },
  });
  check('Reception login succeeds', recLogin.status === 200 && recLogin.data.user.role === 'RECEPTIONIST', recLogin.data);
  const receptionToken = recLogin.data?.accessToken;

  // 3. Session Management Endpoints
  console.log('\n--- 3. Session Management Endpoints ---');
  const mySessions = await doctorClient.call('GET', '/sessions', { token: doctorToken });
  check(
    'GET /sessions returns user sessions array',
    mySessions.status === 200 && Array.isArray(mySessions.data?.sessions) && mySessions.data.sessions.length > 0,
    mySessions.data,
  );

  const authSessions = await doctorClient.call('GET', '/auth/sessions', { token: doctorToken });
  check('GET /auth/sessions (alias) also returns sessions', authSessions.status === 200, authSessions.status);

  const doctorForbiddenAdminSessions = await doctorClient.call('GET', '/admin/sessions', { token: doctorToken });
  check(
    'Doctor cannot access GET /admin/sessions (403 FORBIDDEN)',
    doctorForbiddenAdminSessions.status === 403 && doctorForbiddenAdminSessions.data?.error?.code === 'FORBIDDEN',
    doctorForbiddenAdminSessions.data,
  );

  const adminSessions = await adminClient.call('GET', '/admin/sessions', { token: adminToken });
  check(
    'Admin can access GET /admin/sessions',
    adminSessions.status === 200 && Array.isArray(adminSessions.data?.sessions),
    adminSessions.data?.sessions?.length,
  );

  // Terminate a session via DELETE /sessions/:id
  const testLogin = makeClient();
  const tLogin = await testLogin.call('POST', '/auth/login', {
    body: { email: 'reception@ultrasound.clinic', password: PASSWORD },
  });
  const tToken = tLogin.data?.accessToken;
  const tSessions = await testLogin.call('GET', '/sessions', { token: tToken });
  const sessionToKill = tSessions.data?.sessions?.[0]?.id;
  if (sessionToKill) {
    const term = await testLogin.call('DELETE', `/sessions/${sessionToKill}`, { token: tToken });
    check('DELETE /sessions/:id terminates session with 204', term.status === 204, term.status);
  }

  // 4. Token Invalidation on Logout (JWT Blacklist)
  console.log('\n--- 4. Token Blacklist on Logout ---');
  const logoutTestClient = makeClient();
  const lLogin = await logoutTestClient.call('POST', '/auth/login', {
    body: { email: 'reception@ultrasound.clinic', password: PASSWORD },
  });
  const logoutToken = lLogin.data?.accessToken;

  // Verify token works before logout
  const preLogoutCheck = await logoutTestClient.call('GET', '/auth/me', { token: logoutToken });
  check('Token works before logout', preLogoutCheck.status === 200, preLogoutCheck.status);

  // Perform logout
  const logoutRes = await logoutTestClient.call('POST', '/auth/logout', { token: logoutToken });
  check('POST /auth/logout returns 204', logoutRes.status === 204, logoutRes.status);

  // Verify access token is blacklisted and immediately rejected
  const postLogoutCheck = await logoutTestClient.call('GET', '/auth/me', { token: logoutToken });
  check(
    'Blacklisted access token is rejected with 401 UNAUTHORIZED',
    postLogoutCheck.status === 401 && postLogoutCheck.data?.error?.code === 'UNAUTHORIZED',
    postLogoutCheck.data,
  );

  // 5. Clinician Report Flow & Print-Data
  console.log('\n--- 5. Clinician Report & Print-Data Flow ---');
  // Create patient as reception
  const patientRes = await receptionClient.call('POST', '/patients', {
    token: receptionToken,
    body: {
      firstName: 'Layla',
      lastName: 'Ahmed',
      dateOfBirth: '1992-05-14',
      gender: 'FEMALE',
      phone: `+20 100 ${Math.floor(1000000 + Math.random() * 9000000)}`,
    },
  });
  const patientId = patientRes.data?.patient?.id;
  check('Patient created for clinical flow', patientRes.status === 201, patientRes.data);

  // Create visit as doctor
  const visitRes = await doctorClient.call('POST', '/visits', {
    token: doctorToken,
    body: {
      patientId,
      visitDate: new Date().toISOString(),
      chiefComplaint: 'Pelvic pain and routine ultrasound scan',
    },
  });
  const visitId = visitRes.data?.visit?.id;
  check('Doctor creates clinical visit', visitRes.status === 201, visitRes.data);

  // Create report as doctor
  const reportRes = await doctorClient.call('POST', '/reports', {
    token: doctorToken,
    body: {
      visitId,
      content: {
        indication: 'Pelvic pain evaluation',
        findings: 'Normal liver and kidneys. No focal lesions. Free fluid absent.',
        impression: 'Normal pelvic ultrasound study.',
        recommendations: 'Follow up as needed clinically.',
      },
    },
  });
  const reportId = reportRes.data?.report?.id;
  check('Doctor creates ultrasound report', reportRes.status === 201, reportRes.data);

  // Finalize report
  const finRes = await doctorClient.call('POST', `/reports/${reportId}/finalize`, { token: doctorToken });
  check('Doctor finalizes report', finRes.status === 200, finRes.data);

  // Test GET /reports/:id/print-data endpoint
  const printDataRes = await doctorClient.call('GET', `/reports/${reportId}/print-data`, { token: doctorToken });
  const pd = printDataRes.data;
  const printValid =
    printDataRes.status === 200 &&
    pd.clinic?.name &&
    pd.report?.id === reportId &&
    pd.report?.status === 'FINALIZED' &&
    pd.patient?.firstName === 'Layla' &&
    pd.examination?.doctor;
  check('Doctor fetches report print-data successfully with complete structure', printValid, pd);

  // Verify RBAC: Reception cannot fetch print-data (lacks CLINICAL_READ)
  const recPrint = await receptionClient.call('GET', `/reports/${reportId}/print-data`, { token: receptionToken });
  check('Reception cannot access report print-data (403)', recPrint.status === 403, recPrint.status);

  // Verify Doctor Isolation: Doctor 2 cannot fetch Doctor 1's report print-data
  const doc2Print = await doctor2Client.call('GET', `/reports/${reportId}/print-data`, { token: doctor2Token });
  check("Doctor 2 cannot access Doctor 1's report print-data (403)", doc2Print.status === 403, doc2Print.status);

  // 6. Forced Password Change Flow (mustChangePassword)
  console.log('\n--- 6. Forced Password Change Flow ---');
  const tempLogin = await tempUserClient.call('POST', '/auth/login', {
    body: { email: 'temp.user@ultrasound.clinic', password: TEMP_PASSWORD },
  });
  check(
    'Temp user logs in and receives mustChangePassword: true',
    tempLogin.status === 200 && tempLogin.data?.user?.mustChangePassword === true,
    tempLogin.data?.user,
  );
  const tempToken = tempLogin.data?.accessToken;

  // Change password
  const newPass = `Aa1!${randomUUID()}`;
  const changeRes = await tempUserClient.call('POST', '/auth/change-password', {
    token: tempToken,
    body: {
      currentPassword: TEMP_PASSWORD,
      newPassword: newPass,
    },
  });
  check('Password change succeeds', changeRes.status === 200 && Boolean(changeRes.data?.accessToken), changeRes.data);

  // Verify user now has mustChangePassword: false
  const meCheck = await tempUserClient.call('GET', '/auth/me', { token: changeRes.data.accessToken });
  check('mustChangePassword is now false on /auth/me', meCheck.status === 200 && meCheck.data?.user?.mustChangePassword === false, meCheck.data?.user);

  // Verify login with new password succeeds and has mustChangePassword: false
  const newLogin = await tempUserClient.call('POST', '/auth/login', {
    body: { email: 'temp.user@ultrasound.clinic', password: newPass },
  });
  check('Login with new password succeeds with mustChangePassword: false', newLogin.status === 200 && newLogin.data?.user?.mustChangePassword === false, newLogin.data?.user);

  // Reset temp user back to the seeded temporary password for future tests
  await tempUserClient.call('POST', '/auth/change-password', {
    token: newLogin.data.accessToken,
    body: { currentPassword: newPass, newPassword: TEMP_PASSWORD },
  });

  // Summary
  console.log(`\n======================================================`);
  console.log(`Verification Results: ${passed} passed, ${failures.length} failed`);
  console.log(`======================================================`);
  if (failures.length) {
    console.log('\nFailed checks:');
    for (const f of failures) console.log(` - ${f}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('\nVerification suite crashed:', err);
  process.exitCode = 1;
});

