import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  base: '/kds/',
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5175,
    proxy: {
      '/api': { target: API, rewrite: (p) => p.replace(/^\/api/, '') },
      '/socket.io': { target: API, ws: true },
    },
  },
});
