import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

const marketingRoot = path.resolve(__dirname, 'Dcalls web');
const marketingRoutes: Record<string, string> = {
  '/welcome.html': 'index.HTML',
  '/damai.html': 'damai.HTML',
  '/teams.html': 'teams.HTML',
  '/help.html': 'help.HTML',
};

function dcallsMarketingPlugin() {
  return {
    name: 'dcalls-marketing',
    configureServer(server: { middlewares: { use: Function } }) {
      server.middlewares.use((req: { url?: string }, res: { setHeader: Function; end: Function }, next: () => void) => {
        const url = req.url?.split('?')[0] ?? '';
        const file = marketingRoutes[url];
        if (file) {
          const filePath = path.join(marketingRoot, file);
          if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(fs.readFileSync(filePath));
            return;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss(), dcallsMarketingPlugin()],
    base: './',

    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
