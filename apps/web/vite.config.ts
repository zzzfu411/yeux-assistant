import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root:fileURLToPath(new URL('.',import.meta.url)),
  plugins:[react()],
  build:{outDir:fileURLToPath(new URL('../../dist/web',import.meta.url)),emptyOutDir:true},
  server:{host:'127.0.0.1',port:5173,proxy:{'/api':{target:process.env.ASSISTANT_API_URL||'http://127.0.0.1:8766',changeOrigin:false}}}
});
