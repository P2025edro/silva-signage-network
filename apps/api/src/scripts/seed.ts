// Creates the first Silva super admin (if missing) and, with --demo, two clearly labelled
// fictional businesses for demonstrating cross-business distribution.
// --demo is refused when NODE_ENV=production.
//
//   pnpm db:seed                       # super admin only
//   pnpm db:seed --demo                # + two DEV FIXTURE companies with owners, locations, media, a draft campaign
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createDeps } from '../bootstrap.js';
import { audit } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { processUpload } from '../lib/media.js';

const deps = createDeps();
const { sql, config } = deps;
const demo = process.argv.includes('--demo');
// DEMO_MODE marks a separate, public demo deployment (its own database), where fictional,
// clearly labelled demo businesses are the point. A real production deployment never sets it.
if (demo && config.NODE_ENV === 'production' && !config.DEMO_MODE) {
  console.error('Refusing to create demo fixtures in production. Run without --demo to create only the first admin.');
  process.exit(1);
}
const genPassword = () => randomBytes(12).toString('base64url');
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const created: string[] = [];

async function ensureUser(email: string, fullName: string, role: 'SUPER_ADMIN' | 'NONE', password?: string) {
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL`;
  if (existing) return { id: existing.id, password: null as string | null };
  const pw = password ?? genPassword();
  const [u] = await sql<{ id: string }[]>`INSERT INTO users (email, password_hash, full_name, platform_role)
    VALUES (${email}, ${await hashPassword(pw, config.SCRYPT_LOG_N)}, ${fullName}, ${role}) RETURNING id`;
  // Passwords supplied through the environment are never echoed (build logs are kept).
  created.push(`${role === 'SUPER_ADMIN' ? 'Silva super admin' : fullName}: ${email}${password ? '' : ` / ${pw}`}`);
  return { id: u!.id, password: pw };
}

const label = config.DEMO_MODE ? 'DEMO — fictional business, not a real advert' : 'DEVELOPMENT FIXTURE — fictional business, not a real advert';

async function advertImage(title: string, subtitle: string, color: string): Promise<Buffer> {
  // Serverless build images have no system fonts for SVG text, so prefer the pre-rendered copy.
  const pre = join(dirname(fileURLToPath(import.meta.url)), '../../assets/demo', `${slug(title)}.png`);
  if (config.DEMO_MODE && existsSync(pre)) return readFileSync(pre);
  const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
    <rect width="1920" height="1080" fill="${color}"/>
    <rect x="60" y="60" width="1800" height="960" fill="none" stroke="#ffffff" stroke-opacity="0.25" stroke-width="4"/>
    <text x="960" y="470" font-family="Arial, sans-serif" font-size="110" font-weight="700" fill="#fff" text-anchor="middle">${esc(title)}</text>
    <text x="960" y="590" font-family="Arial, sans-serif" font-size="56" fill="#fff" fill-opacity="0.85" text-anchor="middle">${esc(subtitle)}</text>
    <text x="960" y="960" font-family="Arial, sans-serif" font-size="34" fill="#fff" fill-opacity="0.7" text-anchor="middle">${label}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function demoCompany(
  adminId: string,
  opts: { name: string; category: string; zones: string[]; email: string; street: string; color: string; headline: string },
) {
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM companies WHERE name = ${opts.name} AND is_dev_fixture`;
  if (existing) {
    console.log(`  ${opts.name} already exists, skipping`);
    return existing.id;
  }
  const owner = await ensureUser(opts.email, `${opts.name} owner`, 'NONE', process.env.DEMO_OWNER_PASSWORD || undefined);
  const [cat] = await sql<{ id: string }[]>`SELECT id FROM business_categories WHERE slug = ${opts.category}`;
  const processed = await processUpload(await advertImage(opts.headline, opts.name.replace(/^(DEV FIXTURE|DEMO) — /, ''), opts.color), {
    maxImageBytes: config.MEDIA_MAX_IMAGE_BYTES,
    maxVideoBytes: config.MEDIA_MAX_VIDEO_BYTES,
    maxVideoSeconds: config.MEDIA_MAX_VIDEO_SECONDS,
  });
  return sql.begin(async (tx) => {
    const [c] = await tx<{ id: string }[]>`INSERT INTO companies (name, email, category_id, is_dev_fixture, contact_name)
      VALUES (${opts.name}, ${opts.email}, ${cat!.id}, true, ${'Fictional contact'}) RETURNING id`;
    const companyId = c!.id;
    await tx`INSERT INTO user_company_memberships (user_id, company_id, role) VALUES (${owner.id}, ${companyId}, 'OWNER')`;
    const [plan] = await tx<{ id: string }[]>`SELECT id FROM subscription_plans WHERE code = 'business'`;
    await tx`INSERT INTO subscriptions (company_id, plan_id, status, source, current_period_start, current_period_end, note, created_by)
      VALUES (${companyId}, ${plan!.id}, 'ACTIVE', 'MANUAL', now(), now() + interval '30 days', ${config.DEMO_MODE ? 'Demo entitlement — not a payment' : 'Development fixture entitlement — not a payment'}, ${adminId})`;
    const [loc] = await tx<{ id: string }[]>`INSERT INTO locations (company_id, name, street_address, city, category_id)
      VALUES (${companyId}, ${opts.name.replace(/^(DEV FIXTURE|DEMO) — /, '') + (config.DEMO_MODE ? ' (demo location)' : ' (dev location)')}, ${opts.street}, 'Dublin', ${cat!.id}) RETURNING id`;
    for (const slug of opts.zones) {
      await tx`INSERT INTO location_zones (location_id, zone_id) SELECT ${loc!.id}, id FROM geographic_zones WHERE slug = ${slug}`;
    }
    const [m] = await tx<{ id: string }[]>`INSERT INTO media_assets (company_id, kind, status, original_filename, detected_mime, size_bytes, sha256,
        width, height, storage_key, thumbnail_key, uploaded_by)
      VALUES (${companyId}, 'IMAGE', 'READY', 'dev-fixture-advert.png', ${processed.detectedMime}, ${processed.delivery.length}, ${Buffer.alloc(32)},
        ${processed.width}, ${processed.height}, ${`companies/${companyId}/media/seed/delivery.jpg`}, ${`companies/${companyId}/media/seed/thumb.jpg`}, ${owner.id})
      RETURNING id`;
    await deps.storage.put(`companies/${companyId}/media/seed/delivery.jpg`, processed.delivery, 'image/jpeg');
    await deps.storage.put(`companies/${companyId}/media/seed/thumb.jpg`, processed.thumbnail, 'image/jpeg');
    const [camp] = await tx<{ id: string }[]>`INSERT INTO campaigns (company_id, name, description, start_at, end_at, created_by)
      VALUES (${companyId}, ${opts.headline}, ${config.DEMO_MODE ? 'Demo campaign (fictional business)' : 'Development fixture campaign'}, now(), now() + interval '14 days', ${owner.id}) RETURNING id`;
    await tx`INSERT INTO campaign_media (campaign_id, media_asset_id, display_seconds) VALUES (${camp!.id}, ${m!.id}, 10)`;
    await audit(tx, { actorType: 'SYSTEM', companyId, action: 'seed.dev_fixture_created', entityType: 'company', entityId: companyId });
    console.log(`  Created ${opts.name} with a location, an advert image and a DRAFT campaign`);
    return companyId;
  });
}

const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@silvasolutions.dev.invalid').toLowerCase();
const admin = await ensureUser(adminEmail, 'Silva Administrator', 'SUPER_ADMIN', process.env.SEED_ADMIN_PASSWORD);

if (demo) {
  console.log('Creating demo fixtures (fictional businesses):');
  await demoCompany(admin.id, {
    name: config.DEMO_MODE ? 'DEMO — Liffey Barbers' : 'DEV FIXTURE — Company A Barbers',
    category: 'barbershop',
    zones: ['camden-street', 'dublin-8'],
    email: config.DEMO_MODE ? 'barbers@demo.silva.invalid' : 'owner-a@dev-fixture.invalid',
    street: '1 Example Street, Dublin 2',
    color: '#0f5c46',
    headline: 'Fresh fades, every day',
  });
  await demoCompany(admin.id, {
    name: config.DEMO_MODE ? 'DEMO — Portobello Bistro' : 'DEV FIXTURE — Company B Bistro',
    category: 'restaurant',
    zones: ['portobello', 'dublin-8'],
    email: config.DEMO_MODE ? 'bistro@demo.silva.invalid' : 'owner-b@dev-fixture.invalid',
    street: '2 Example Road, Dublin 8',
    color: '#7a2e1d',
    headline: 'Lunch specials from noon',
  });
}

console.log(created.length ? `\nNew sign-ins (shown once — store them safely):\n  ${created.join('\n  ')}` : '\nNo new users were created.');
if (config.ALLOW_ADMIN_WITHOUT_MFA)
  console.log('\nALLOW_ADMIN_WITHOUT_MFA=true: the admin can sign in without 2FA in this environment. Turn it on under Settings.');
await sql.end();
