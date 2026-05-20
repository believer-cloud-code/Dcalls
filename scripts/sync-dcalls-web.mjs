/**
 * Copies Dcalls web marketing assets into public/ for Vite + Firebase Hosting.
 * Run: node scripts/sync-dcalls-web.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'Dcalls web');
const publicDir = path.join(root, 'public');

const files = ['index.HTML', 'help.HTML', 'damai.HTML', 'teams.HTML', 'dcalls.ico', 'logo.png'];

if (!fs.existsSync(srcDir)) {
  console.warn('Dcalls web folder not found, skipping sync.');
  process.exit(0);
}

fs.mkdirSync(publicDir, { recursive: true });

for (const file of files) {
  const from = path.join(srcDir, file);
  if (!fs.existsSync(from)) continue;

  let destName = file;
  if (file === 'index.HTML') destName = 'welcome.html';
  if (file.endsWith('.HTML')) {
    destName = file.replace(/\.HTML$/i, '.html');
  }

  const to = path.join(publicDir, destName);
  let content = fs.readFileSync(from, 'utf8');

  if (destName === 'welcome.html') {
    content = content.replace(
      '<script src="https://cdn.tailwindcss.com"></script>',
      '<script src="/dcalls-config.js"></script>\n    <script src="https://cdn.tailwindcss.com"></script>'
    );
    content = content.replace(
      /function openWebApp\(\) \{[\s\S]*?\}/,
      `function openWebApp() {
            if (window.DcallsUrls) {
                window.DcallsUrls.openWebApp(true);
                return;
            }
            window.location.href = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
                ? 'http://localhost:3000'
                : 'https://app.dcalls.com';
        }`
    );
    content = content.replace(/href="index\.HTML"/gi, 'href="/welcome.html"');
    content = content.replace(/href="damai\.HTML"/gi, 'href="/damai.html"');
    content = content.replace(/href="teams\.HTML"/gi, 'href="/teams.html"');
    content = content.replace(/href="help\.HTML"/gi, 'href="/help.html"');
  }

  fs.writeFileSync(to, content, 'utf8');
  console.log(`Synced ${file} → public/${destName}`);
}

console.log('Dcalls web sync complete.');
