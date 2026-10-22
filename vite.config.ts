import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { justMusicApi } from './server/api';

export default defineConfig({
  plugins: [react(), justMusicApi()],
  server: { host: true },
  preview: { host: true },
});
