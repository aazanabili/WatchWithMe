const { spawn } = require('node:child_process');
const child = spawn('npm', ['run', 'dev', '--workspace', '@watch-with-me/web'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    NEXT_PUBLIC_API_URL: '/api',
    NEXT_PUBLIC_SOCKET_URL: 'http://127.0.0.1:4000',
  },
});
process.on('SIGTERM', () => child.kill());
process.on('SIGINT', () => child.kill());
child.on('exit', (code) => process.exit(code ?? 1));
