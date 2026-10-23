import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, setup, silvaUser, type TestContext } from './helpers.js';

describe('website enquiries', () => {
  let ctx: TestContext;
  let admin: Client;
  before(async () => {
    ctx = await setup();
    ({ client: admin } = await silvaUser(ctx));
  });
  after(() => ctx.close());

  const lead = { businessName: 'Test Café (fixture)', contactName: 'Aoife Test', email: 'Aoife@Example.test', phone: '+353 1 000 0000', area: 'Portobello', screensEstimate: 1, interestedPlan: 'business', consent: true };

  test('anyone can submit an enquiry; Silva staff see it', async () => {
    const res = await new Client(ctx.app).post('/api/public/leads', lead);
    assert.equal(res.status, 201);
    const list = await admin.get('/api/admin/leads');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].email, 'aoife@example.test');
    assert.equal(list.body[0].status, 'NEW');
    assert.equal((await admin.get('/api/admin/overview')).body.newLeads, 1);
  });

  test('consent is required', async () => {
    const res = await new Client(ctx.app).post('/api/public/leads', { ...lead, consent: false });
    assert.equal(res.status, 400);
  });

  test('honeypot submissions are accepted silently but not stored', async () => {
    const res = await new Client(ctx.app).post('/api/public/leads', { ...lead, website: 'http://spam.example' });
    assert.equal(res.status, 201);
    assert.equal((await admin.get('/api/admin/leads')).body.length, 1);
  });

  test('submissions are rate-limited per address', async () => {
    const c = new Client(ctx.app);
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await c.post('/api/public/leads', { ...lead, website: 'x' })).status);
    assert.ok(codes.includes(429));
  });

  test('staff update status; businesses cannot read leads', async () => {
    const [l] = (await admin.get('/api/admin/leads')).body;
    assert.equal((await admin.patch(`/api/admin/leads/${l.id}`, { status: 'CONTACTED', notes: 'Called, visit Tuesday' })).status, 200);
    assert.equal((await admin.get('/api/admin/leads?status=CONTACTED')).body.length, 1);
    assert.equal((await new Client(ctx.app).get('/api/admin/leads')).status, 401);
  });
});
