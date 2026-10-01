import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  base: '/tablet/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: { name: 'Nhà hàng Sen – Gọi món', short_name: 'Sen', display: 'fullscreen', theme_color: '#c93370', background_color: '#fafaf9', start_url: '/tablet/' },
      workbox: {
        // Cache menu và ảnh món để tablet vẫn hiển thị khi rớt mạng (mục 3.1).
        runtimeCaching: [
          { urlPattern: ({ url }) => url.pathname.startsWith('/api/menu'), handler: 'NetworkFirst', options: { cacheName: 'menu', networkTimeoutSeconds: 3 } },
          { urlPattern: ({ request }) => request.destination === 'image', handler: 'CacheFirst', options: { cacheName: 'images' } },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, rewrite: (p) => p.replace(/^\/api/, '') },
      '/socket.io': { target: API, ws: true },
    },
  },
});
