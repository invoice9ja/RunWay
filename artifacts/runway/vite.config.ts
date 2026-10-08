import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const isProduction = process.env.NODE_ENV === 'production';

// The browser wallet talks to the chain through a same-origin JSON-RPC relay,
// normally the `/api/rpc` serverless function. In plain `vite dev` that
// function is not mounted, so forward it here instead.
const rpcProxy = {
  '/api/rpc': {
    target: 'https://rpc.testnet.arc.network',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api\/rpc/, ''),
  },
};

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(!isProduction && process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: rpcProxy,
  },
  preview: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: rpcProxy,
  },
});
