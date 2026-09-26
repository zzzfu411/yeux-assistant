import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicit opt-in: this suite only targets a disposable API/Worker instance.
test.skip(process.env.ASSISTANT_REAL_E2E!=='1','Set ASSISTANT_REAL_E2E=1 and point PLAYWRIGHT_BASE_URL at the disposable instance.');
test('真实 PostgreSQL 与 Worker：资料→目标→自评→复习记录→本人确认完成',async({page,request},testInfo)=>{
  test.setTimeout(90_000);
  const token=(await readFile(resolve(process.env.ASSISTANT_E2E_TOKEN_FILE||'private/e2e-instance/access-token'),'utf8')).trim();
  const suffix=testInfo.project.name+'-'+Date.now(),title='浏览器验收 '+suffix,source='验收资料 '+suffix;
  await page.goto('/');await page.getByLabel('访问口令',{exact:true}).fill(token);await page.getByRole('button',{name:'进入',exact:true}).click();await expect(page.getByRole('heading',{name:'今天，向前一步。'})).toBeVisible();
  await page.getByRole('link',{name:'资料',exact:true}).click();await page.getByRole('button',{name:'添加资料',exact:true}).click();await page.getByLabel('标题',{exact:true}).fill(source);await page.getByRole('textbox',{name:'原文',exact:true}).fill('需求分析从使用者的具体问题开始。验收标准描述可观察的行为，例如点击保存后 2 秒内显示结果。');await page.getByRole('button',{name:'保存资料',exact:true}).click();await expect(page.getByRole('heading',{name:source,exact:true})).toBeVisible();
  await page.getByRole('link',{name:'今天',exact:true}).click();await page.getByLabel('想学什么').fill(title);await page.getByText('补充要求',{exact:true}).click();await page.getByLabel('希望达到什么程度').fill('理解需求分析，写出可验证的验收标准');await page.getByRole('checkbox',{name:source,exact:true}).check();await page.getByRole('button',{name:'开始',exact:true}).click();await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  await expect(page.getByLabel('说说你的理解')).toBeVisible({timeout:30_000});const sessionId=page.url().split('/session/')[1]!;
  await page.getByLabel('说说你的理解').fill('验收标准必须可观察：点击保存后 2 秒内出现成功结果，这是使用者能直接验证的行为。');await page.getByText('补充自评',{exact:true}).click();await page.getByLabel('我对这一步的理解').selectOption('understood');await page.getByRole('button',{name:'继续',exact:true}).click();
  const getSession=async()=>{const response=await request.get('/api/v2/sessions/'+sessionId,{headers:{Authorization:'Bearer '+token}});expect(response.ok()).toBeTruthy();return response.json();};
  await expect.poll(async()=>(await getSession()).session.state,{timeout:30_000}).toBe('completed');const detail=await getSession();expect(detail.attempts.at(-1)).toMatchObject({verdict:'pass',source:'user_report'});expect(detail.session.citations.length).toBeGreaterThan(0);
  await page.getByRole('link',{name:'‹ 返回目标',exact:true}).click();await expect(page.getByRole('heading',{name:'学习路径'})).toBeVisible();await page.getByRole('button',{name:'标记完成',exact:true}).click();await page.getByRole('button',{name:'我已完成这个目标',exact:true}).click();await expect.poll(async()=>{const response=await request.get('/api/v2/goals/'+detail.session.goalId,{headers:{Authorization:'Bearer '+token}});return (await response.json()).goal.status;}).toBe('completed');
  await page.screenshot({path:testInfo.outputPath('real-completed.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.locator('summary').filter({hasText:/^更多/}).click();await page.getByRole('link',{name:'历史',exact:true}).click();await expect(page.getByRole('link',{name:new RegExp(title)})).toBeVisible();
  await page.locator('summary').filter({hasText:/^更多/}).click();await page.getByRole('link',{name:'定时计划',exact:true}).click();await page.getByRole('button',{name:'添加计划',exact:true}).click();await page.getByLabel('计划名称').fill('暂停的验收计划 '+suffix);await page.getByRole('textbox',{name:'要准备什么',exact:true}).fill('复习验收标准。');await page.getByRole('checkbox',{name:'启用计划'}).uncheck();await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect(page.getByText('暂停的验收计划 '+suffix+' · 已暂停',{exact:true})).toBeVisible();
  await page.locator('summary').filter({hasText:/^更多/}).click();await page.getByRole('link',{name:'设置',exact:true}).click();await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeVisible();
});
