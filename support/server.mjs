import { pathToFileURL } from 'node:url';
import { createBusinessServer } from './app.mjs';

const port = Number(process.env.PORT ?? 4318);
const host = process.env.HOST ?? '127.0.0.1';
const app = createBusinessServer();

const server = app.server.listen(port, host, () => {
  const address = server.address();
  console.log(JSON.stringify({
    message: '合成顾问室业务服务已启动',
    baseUrl: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    stateFile: app.store.stateFile,
    partnerUrl: app.signing.baseUrl,
    warning: '仅使用虚构机构和合成文件；X-Actor-Id 是本地开发角色，不是生产认证'
  }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 直接执行 support/server.mjs 时保持进程；被测试 import 时不额外处理。
}
