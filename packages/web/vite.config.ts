import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'PULSE_METRIC_STUDIO_');
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: env.PULSE_METRIC_STUDIO_API_PROXY_TARGET || 'http://127.0.0.1:4620',
          changeOrigin: true,
        },
      },
    },
  };
});
