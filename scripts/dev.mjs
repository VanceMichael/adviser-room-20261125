import { spawn } from 'node:child_process';

const partnerPort = process.env.PARTNER_PORT ?? '4317';
const businessPort = process.env.PORT ?? '4318';
const host = process.env.HOST ?? '127.0.0.1';

const children = [];
function run(name, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  const prefix = `[${name}] `;
  child.stdout.on('data', chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(line => console.log(prefix + line)));
  child.stderr.on('data', chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(line => console.error(prefix + line)));
  child.on('exit', code => {
    if (code && code !== 0) console.error(`${name} 退出，代码 ${code}`);
    shutdown(code ?? 0);
  });
  return child;
}

function shutdown(code = 0) {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 100).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('signing', 'support/peer.mjs', {
  PORT: partnerPort,
  PARTNER_STATE: process.env.PARTNER_STATE ?? '.local/partner.json'
});
run('business', 'support/server.mjs', {
  PORT: businessPort,
  HOST: host,
  APP_STATE: process.env.APP_STATE ?? '.local/app-state.json',
  PARTNER_URL: process.env.PARTNER_URL ?? `http://127.0.0.1:${partnerPort}`
});

console.log(`本地服务：业务 http://127.0.0.1:${businessPort}，电子签署替身 http://127.0.0.1:${partnerPort}`);
