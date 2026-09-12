import { defineConfig } from 'vite';

export default defineConfig({
  base: '/audio-to-midi/',
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
