// End-to-end proof of the core promise, through the real UI, API, database and TV player:
// Company A uploads an advert, Silva approves it, and it plays on Company B's paired screen.
// All companies here are explicitly labelled development fixtures.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = { email: 'admin@e2e.invalid', password: 'e2e-admin-password-123' };
const OWNER_PASSWORD = 'owner-password-e2e-123';
const run = Date.now().toString(36);
const A = { name: `DEV FIXTURE — E2E Company A ${run}`, owner: `owner-a-${run}@e2e.invalid`, id: '' };
const B = { name: `DEV FIXTURE — E2E Company B ${run}`, owner: `owner-b-${run}@e2e.invalid`, id: '' };
let campaignId = '';

test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser, email: string, password: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/(admin|portal)$/);
  return page;
}

async function createCompany(admin: Page, c: typeof A) {
  await admin.goto('/admin/companies');
  await admin.getByRole('button', { name: 'New company' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Company name').fill(c.name);
  await dialog.getByLabel('Business email').fill(`contact-${c.owner}`);
  await dialog.getByLabel('This is a development / test fixture').check();
  await dialog.getByLabel('Owner name').fill('Fixture Owner');
  await dialog.getByLabel('Owner email').fill(c.owner);
  await dialog.getByLabel('Temporary password').fill(OWNER_PASSWORD);
  await dialog.getByRole('button', { name: 'Create company' }).click();
  await admin.waitForURL(/\/admin\/companies\/[0-9a-f-]{36}$/);
  c.id = admin.url().split('/').pop()!;

  await admin.getByRole('button', { name: 'Grant manual subscription' }).click();
  const grant = admin.getByRole('dialog');
  await grant.getByLabel('Plan').selectOption('business');
  await grant.getByLabel('Reason').fill('E2E development fixture — not a payment');
  await grant.getByRole('button', { name: 'Grant' }).click();
  await expect(admin.getByText('Manual subscription granted')).toBeVisible();
}

async function addEstablishment(owner: Page, name: string) {
  await owner.goto('/portal/establishments');
  await owner.getByRole('button', { name: 'Add establishment' }).first().click();
  const d = owner.getByRole('dialog');
  await d.getByLabel('Establishment name').fill(name);
  await d.getByLabel('Street address').fill('1 Example Street');
  await d.getByLabel('Eircode').fill('D08 XY12');
  await d.getByLabel('Dublin 8').check();
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(owner.getByText('Establishment added')).toBeVisible();
}

test('Silva admin creates two participating businesses with subscriptions', async ({ browser }) => {
  const admin = await signIn(browser, ADMIN.email, ADMIN.password);
  await createCompany(admin, A);
  await createCompany(admin, B);
  await admin.goto('/admin/companies');
  await expect(admin.getByText(A.name)).toBeVisible();
  await expect(admin.getByText(B.name)).toBeVisible();
});

test('Company A registers a location, uploads an advert and submits a campaign', async ({ browser }) => {
  const owner = await signIn(browser, A.owner, OWNER_PASSWORD);
  await addEstablishment(owner, 'Company A barbershop (fixture)');

  await owner.goto('/portal/media');
  await owner.locator('input[type=file]').first().setInputFiles(join(here, '.fixtures/company-a-advert.png'));
  await expect(owner.getByText('Upload processed and ready')).toBeVisible({ timeout: 30_000 });

  await owner.goto('/portal/campaigns/new');
  await owner.getByLabel('Campaign name').fill('E2E — Autumn fades');
  await owner.getByRole('button', { name: 'Choose from library' }).click();
  await owner
    .getByRole('dialog')
    .getByRole('button', { name: /company-a-advert/ })
    .click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await owner.getByRole('button', { name: 'Save draft' }).click();
  await owner.waitForURL(/\/portal\/campaigns\/[0-9a-f-]{36}$/);
  campaignId = owner.url().split('/').pop()!;

  await owner.getByRole('button', { name: 'Submit for approval' }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(owner.getByText('Submitted for approval')).toBeVisible();
});

test('Silva approves the campaign', async ({ browser }) => {
  const admin = await signIn(browser, ADMIN.email, ADMIN.password);
  await admin.goto('/admin/campaigns');
  await admin.getByRole('link', { name: 'E2E — Autumn fades' }).click();
  await admin.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByText('Campaign is now active')).toBeVisible();
});

test("Company A's advert is delivered to Company B's paired TV, and playback is reported", async ({ browser }) => {
  const ownerB = await signIn(browser, B.owner, OWNER_PASSWORD);
  await addEstablishment(ownerB, 'Company B bistro (fixture)');

  // The TV: a fresh browser opening the player URL, as a Smart TV browser would.
  const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await tv.goto('http://localhost:5274/');
  const codeEl = tv.locator('#code');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!;

  await ownerB.goto('/portal/establishments');
  await ownerB.getByRole('button', { name: 'Pair a screen' }).first().click();
  const d = ownerB.getByRole('dialog');
  await d.getByLabel('Code shown on the TV').fill(code);
  await d.getByLabel('Screen name').fill('Dining room TV');
  await d.getByRole('button', { name: 'Pair screen' }).click();
  await expect(ownerB.getByText(/Screen paired/)).toBeVisible();

  // The TV leaves the pairing screen and shows Company A's advert image.
  await expect(tv.locator('#pairing')).not.toHaveClass(/on/, { timeout: 20_000 });
  const shown = tv.locator('img.layer.on');
  await expect(shown).toBeVisible({ timeout: 20_000 });
  expect(await shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1920);
  await tv.screenshot({ path: join(here, '.results/tv-showing-company-a-advert.png') });

  // Company B's host view lists the advertiser's campaign on its screen.
  const screens = await ownerB.request.get(`/api/companies/${B.id}/screens`);
  const [screen] = await screens.json();
  const playlist = await (await ownerB.request.get(`/api/companies/${B.id}/screens/${screen.id}/playlist`)).json();
  expect(playlist.items.map((i: { campaignId: string }) => i.campaignId)).toContain(campaignId);

  // Playback events flow back from the TV and appear in Company A's report.
  const ownerA = await signIn(browser, A.owner, OWNER_PASSWORD);
  await expect
    .poll(async () => (await (await ownerA.request.get(`/api/companies/${A.id}/campaigns/${campaignId}/report`)).json()).totals.started, {
      timeout: 60_000,
      intervals: [3000],
    })
    .toBeGreaterThanOrEqual(1);
  await ownerA.goto(`/portal/campaigns/${campaignId}`);
  await expect(ownerA.getByText('Dining room TV')).toBeVisible();
});

test("Company B cannot access Company A's private information", async ({ browser }) => {
  const ownerB = await signIn(browser, B.owner, OWNER_PASSWORD);
  for (const path of ['', '/campaigns', `/campaigns/${campaignId}`, '/media', '/users', '/billing', '/locations']) {
    const res = await ownerB.request.get(`/api/companies/${A.id}${path}`);
    expect(res.status(), path).toBe(404);
  }
  const admin = await ownerB.request.get('/api/admin/companies');
  expect(admin.status()).toBe(403);
});
