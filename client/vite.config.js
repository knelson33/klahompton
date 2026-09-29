import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5174, host: true }, // host: true so a phone on the same Wi-Fi can join a test voyage
});
