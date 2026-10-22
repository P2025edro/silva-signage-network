import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Creates a clearly fictional advert image for upload during the test.
export default async function globalSetup() {
  const here = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(join(here, '../../apps/api/package.json'));
  const sharp = require('sharp');
  mkdirSync(join(here, '.fixtures'), { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#0f5c46"/>
    <text x="960" y="520" font-family="Arial" font-size="120" font-weight="700" fill="#fff" text-anchor="middle">E2E Company A advert</text>
    <text x="960" y="640" font-family="Arial" font-size="48" fill="#fff" text-anchor="middle">Development fixture — not a real business</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(join(here, '.fixtures/company-a-advert.png'));
}
