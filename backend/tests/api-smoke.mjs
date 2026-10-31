/**
 * Acceptance smoke test for the running API.
 *
 *   node tests/api-smoke.mjs [baseUrl]
 *
 * Verifies the critical rules from the specification:
 *  - first-run setup is single-shot
 *  - role/permission enforcement (reception cannot read clinical)
 *  - cross-doctor isolation by direct id
 *  - concurrent-ish overlapping bookings are rejected
 *  - finalized reports are immutable
 *  - deposits/allocations are not double counted
 *
 * It writes real rows to the target database, so point it at development only.
 */

const BASE = process.argv[2] ?? 'http://localhost:4000/api/v1';

let passed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? ` -> ${JSON.stringify(extra)}` : ''}`);
  }
}

function makeClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
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

const admin = makeClient();
const doctorA = makeClient();
const doctorB = makeClient();
const reception = makeClient();

const stamp = Date.now().toString(36);
const email = (name) => `${name}.${stamp}@clinic.test`;
const PASSWORD = process.env.TEST_PASSWORD;
if (!PASSWORD) {
  throw new Error('Set TEST_PASSWORD to the password used when seeding the test accounts.');
}

function clinicToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDays(dateOnly, days) {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoWeekday(dateOnly) {
  const day = new Date(`${dateOnly}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

async function main() {
  console.log(`\nSmoke test against ${BASE}\n`);

  // --- setup -------------------------------------------------------------
  const status = await admin.call('GET', '/setup/status');
  check('setup status reachable', status.status === 200, status.data);
  let adminToken;
  if (status.data.setupRequired) {
    const setup = await admin.call('POST', '/setup', {
      body: {
        admin: {
          firstName: 'Smoke',
          lastName: 'Admin',
          email: email('admin'),
          password: PASSWORD,
          phone: '+20 100 000 0000',
        },
        clinic: {
          name: 'Smoke Test Clinic',
          timezone: 'Africa/Cairo',
          currency: 'EGP',
          defaultAppointmentMinutes: 15,
        },
      },
    });
    check('setup completes', setup.status === 201, setup.data);
    adminToken = setup.data?.accessToken;
  } else {
    console.log('  --   setup already completed; logging in with existing admin is not possible, using a fresh DB is recommended');
    const login = await admin.call('POST', '/auth/login', {
      body: { email: 'smoke.admin@clinic.test', password: PASSWORD },
    });
    check('admin login', login.status === 200, login.data);
    adminToken = login.data?.accessToken;
  }

  const secondSetup = await admin.call('POST', '/setup', {
    body: {
      admin: { firstName: 'X', lastName: 'Y', email: email('x'), password: PASSWORD },
      clinic: { name: 'Nope' },
    },
  });
  check('setup cannot run twice', secondSetup.status === 409, secondSetup.status);

  // --- staff accounts ----------------------------------------------------
  async function createStaff(role, label) {
    const created = await admin.call('POST', '/users', {
      token: adminToken,
      body: {
        firstName: label,
        lastName: role,
        email: email(label.toLowerCase()),
        role,
        password: PASSWORD,
      },
    });
    check(`${role} account created`, created.status === 201, created.data);
    return created.data.user;
  }

  const docA = await createStaff('DOCTOR', 'Alice');
  const docB = await createStaff('DOCTOR', 'Bob');
  await createStaff('RECEPTIONIST', 'Rita');

  for (const [client, who] of [
    [doctorA, docA],
    [doctorB, docB],
    [reception, null],
  ]) {
    const target = who ?? { email: email('rita') };
    const login = await client.call('POST', '/auth/login', {
      body: {
        email: target.email ?? email('rita'),
        password: PASSWORD,
      },
    });
    check(`login ${target.email ?? 'reception'}`, login.status === 200, login.data);
    if (client === doctorA) var doctorAToken = login.data?.accessToken;
    if (client === doctorB) var doctorBToken = login.data?.accessToken;
    if (client === reception) var receptionToken = login.data?.accessToken;
  }

  // --- patients ----------------------------------------------------------
  const phone = `010${String(Date.now()).slice(-8)}`;
  const created = await reception.call('POST', '/patients', {
    token: receptionToken,
    body: { firstName: 'Mona', lastName: 'Hassan', phone },
  });
  check('reception can create a patient', created.status === 201, created.data);
  const patientId = created.data?.patient?.id;

  const duplicate = await reception.call('POST', '/patients', {
    token: receptionToken,
    body: { firstName: 'Mona', lastName: 'Hassan', phone },
  });
  check('duplicate phone is a soft conflict', duplicate.status === 409, duplicate.status);

  const doctorPatientWrite = await doctorA.call('POST', '/patients', {
    token: doctorAToken,
    body: { firstName: 'No', lastName: 'Write', phone: '0111111111' },
  });
  check('doctor without PATIENTS_WRITE cannot create patients', doctorPatientWrite.status === 403, doctorPatientWrite.status);

  // --- booking -----------------------------------------------------------
  const hours = await reception.call('GET', '/settings/working-hours', { token: receptionToken });
  const openDays = new Set(hours.data.workingHours.filter((h) => h.isOpen).map((h) => h.dayOfWeek));
  let date = null;
  for (let i = 0; i < 14; i += 1) {
    const candidate = addDays(clinicToday(), i + 1);
    if (openDays.has(isoWeekday(candidate))) {
      date = candidate;
      break;
    }
  }
  check('found an open clinic day', Boolean(date), [...openDays]);

  const firstBooking = await reception.call('POST', '/appointments', {
    token: receptionToken,
    body: { patientId, doctorId: docA.id, date, startMinute: 870 },
  });
  check('appointment books', firstBooking.status === 201, firstBooking.data);
  const appointmentId = firstBooking.data?.appointment?.id;

  const clash = await reception.call('POST', '/appointments', {
    token: receptionToken,
    body: { patientId, doctorId: docA.id, date, startMinute: 870 },
  });
  check('overlapping booking for same doctor is rejected', clash.status === 409, clash.status);

  const otherDoctor = await reception.call('POST', '/appointments', {
    token: receptionToken,
    body: { patientId, doctorId: docB.id, date, startMinute: 870 },
  });
  check('same slot is allowed for a different doctor', otherDoctor.status === 201, otherDoctor.data);

  // --- clinical isolation ------------------------------------------------
  const visit = await doctorA.call('POST', '/visits', {
    token: doctorAToken,
    body: { patientId, appointmentId },
  });
  check('doctor A creates a visit', visit.status === 201, visit.data);
  const visitId = visit.data?.visit?.id;

  const crossDoctor = await doctorB.call('GET', `/visits/${visitId}`, { token: doctorBToken });
  check('doctor B cannot read doctor A visit by id', crossDoctor.status === 403, crossDoctor.status);

  const receptionClinical = await reception.call('GET', `/visits/${visitId}`, {
    token: receptionToken,
  });
  check('reception cannot read clinical visit', receptionClinical.status === 403, receptionClinical.status);

  const adminClinical = await admin.call('GET', `/visits/${visitId}`, { token: adminToken });
  check('admin without clinical grant is denied', adminClinical.status === 403, adminClinical.status);

  const noClinicalWrite = await reception.call('POST', `/appointments/${appointmentId}/status`, {
    token: receptionToken,
    body: { status: 'CONFIRMED' },
  });
  check('reception can confirm an appointment', noClinicalWrite.status === 200, noClinicalWrite.data);

  // --- reports -----------------------------------------------------------
  const report = await doctorA.call('POST', '/reports', {
    token: doctorAToken,
    body: {
      visitId,
      content: { indication: 'Pain', findings: 'Normal', impression: 'Normal study' },
    },
  });
  check('draft report created', report.status === 201, report.data);
  const reportId = report.data?.report?.id;

  const finalize = await doctorA.call('POST', `/reports/${reportId}/finalize`, {
    token: doctorAToken,
  });
  check('report finalizes', finalize.status === 200, finalize.data);

  const editFinal = await doctorA.call('PATCH', `/reports/${reportId}`, {
    token: doctorAToken,
    body: { content: { findings: 'Overwritten' } },
  });
  check('finalized report cannot be silently overwritten', editFinal.status === 403, editFinal.status);

  const amend = await doctorA.call('POST', `/reports/${reportId}/amend`, {
    token: doctorAToken,
    body: { content: { findings: 'Corrected' }, reason: 'Typo in findings' },
  });
  check('amendment creates a new version', amend.status === 200 && amend.data.report.versionNumber === 2, amend.data);

  const crossReport = await doctorB.call('GET', `/reports/${reportId}`, { token: doctorBToken });
  check('doctor B cannot read doctor A report', crossReport.status === 403, crossReport.status);

  // --- money -------------------------------------------------------------
  const charge = await reception.call('POST', '/payments/charges', {
    token: receptionToken,
    body: { patientId, description: 'Abdominal ultrasound', amountMinor: 50000 },
  });
  check('charge recorded separately from payment', charge.status === 201, charge.data);
  const chargeId = charge.data?.charge?.id;

  const payment = await reception.call('POST', '/payments', {
    token: receptionToken,
    body: {
      patientId,
      amountMinor: 30000,
      methodKey: 'CASH',
      allocations: [{ chargeId, amountMinor: 20000 }],
    },
  });
  check('partial payment with allocation records', payment.status === 201, payment.data);

  const ledger = await reception.call('GET', `/patients/${patientId}/ledger`, { token: receptionToken });
  const summary = ledger.data?.summary;
  check('ledger is reachable for reception', ledger.status === 200, ledger.status);
  check('charges counted separately', summary?.chargesMinor === 50000, summary);
  check('collected money is 30000', summary?.paymentsMinor === 30000, summary);
  check('outstanding is not double counted', summary?.outstandingMinor === 30000, summary);
  check('deposit (unallocated) is 10000', summary?.unallocatedMinor === 10000, summary);

  const receptionRefund = await reception.call('POST', `/payments/${payment.data.payment.id}/refund`, {
    token: receptionToken,
    body: { amountMinor: 1000, reason: 'test refund' },
  });
  check('reception without REFUNDS_WRITE cannot refund', receptionRefund.status === 403, receptionRefund.status);

  const adminRefund = await admin.call('POST', `/payments/${payment.data.payment.id}/refund`, {
    token: adminToken,
    body: { amountMinor: 1000, reason: 'Overpayment returned' },
  });
  check('authorized refund is recorded', adminRefund.status === 201, adminRefund.data);

  // --- refresh rotation --------------------------------------------------
  const refreshed = await reception.call('POST', '/auth/refresh');
  check('refresh rotates a session', refreshed.status === 200 && Boolean(refreshed.data.accessToken), refreshed.status);

  const logout = await reception.call('POST', '/auth/logout');
  check('logout succeeds', logout.status === 204, logout.status);

  // --- summary -----------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailed checks:');
    for (const f of failures) console.log(` - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exitCode = 1;
});
