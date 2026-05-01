import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // react-plotly.js imports 'plotly.js/dist/plotly' — redirect to the smaller basic dist
      'plotly.js/dist/plotly': 'plotly.js-basic-dist/plotly-basic.js',
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
})
