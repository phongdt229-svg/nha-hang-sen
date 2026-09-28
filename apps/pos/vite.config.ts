import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  base: '/pos/',
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: API, rewrite: (p) => p.replace(/^\/api/, '') },
      '/socket.io': { target: API, ws: true },
    },
  },
});
