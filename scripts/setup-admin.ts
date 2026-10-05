import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';
import { setAdministrator } from '../packages/core/src/auth.js';
import { dataFolder } from '../packages/core/src/config.js';

try {
  let username: string, password: string;
  if (stdin.isTTY) {
    let hidden = false;
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (!hidden) stdout.write(chunk);
        done();
      },
    });
    const prompt = createInterface({ input: stdin, output, terminal: true });
    try {
      username = await prompt.question('管理员账号：');
      stdout.write('密码（至少 8 个字符，输入不显示）：');
      hidden = true;
      password = await prompt.question('');
      stdout.write('\n');
    } finally {
      prompt.close();
    }
  } else {
    let text = '';
    for await (const piece of stdin) {
      text += piece;
      if (text.length > 4096) throw new Error('输入过长。');
    }
    const input = JSON.parse(text);
    username = input.username;
    password = input.password;
    if (typeof username !== 'string' || typeof password !== 'string') throw new Error('需要 username 和 password。');
  }
  await setAdministrator(dataFolder(), username, password);
  console.log('管理员已保存。旧浏览器会话失效，请重新登录。');
} catch {
  console.error('管理员设置失败：请检查输入和私密目录权限。');
  process.exitCode = 1;
}
