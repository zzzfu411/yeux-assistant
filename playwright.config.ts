import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const mockPort=Number(process.env.PLAYWRIGHT_MOCK_PORT||4173);
if(!Number.isInteger(mockPort)||mockPort<1024||mockPort>65535)throw new Error('PLAYWRIGHT_MOCK_PORT must be an integer between 1024 and 65535');
const localChrome=process.platform==='darwin'&&existsSync('/Applications/Google Chrome.app');
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:true,workers:2,timeout:30_000,
  expect:{timeout:8000},retries:0,reporter:'list',outputDir:'private/test-results',
  use:{baseURL:process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:'+mockPort,channel:localChrome?'chrome':undefined,trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'desktop',use:{viewport:{width:1280,height:900}}},{name:'phone',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}}],
  webServer:process.env.PLAYWRIGHT_BASE_URL?undefined:{command:'pnpm exec vite --config apps/web/vite.config.ts --host 127.0.0.1 --strictPort --port '+mockPort,url:'http://127.0.0.1:'+mockPort,reuseExistingServer:false,timeout:30_000}
});
