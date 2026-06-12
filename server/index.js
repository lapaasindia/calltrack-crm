// CLI entry point: `npm start` / the LaunchAgent run this. The desktop app
// uses server/app.js directly instead.
import qrcode from 'qrcode-terminal';
import { startServer } from './app.js';

const PORT = Number(process.env.PORT) || 3000;

startServer({ port: PORT }).then(({ urls }) => {
  console.log('\n  CallTrack CRM is running!\n');
  console.log(`  On this computer:  ${urls.local}`);
  for (const u of urls.lan) console.log(`  On office WiFi:    ${u}`);
  console.log(`  Easy to remember:  ${urls.mdns}  (works on iPhones/most Androids)\n`);
  console.log('  Scan to open on a phone:\n');
  qrcode.generate(urls.lan[0] || urls.local, { small: true });
  console.log('');
}).catch((err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is CallTrack already running?`);
    process.exit(1);
  }
  throw err;
});
