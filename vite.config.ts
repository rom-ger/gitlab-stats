import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_PORT = Number(process.env.VITE_API_PORT) || 8787

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
})
