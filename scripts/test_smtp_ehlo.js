// Guards the 2026-11-22 fix: SMTP mail must never greet the server as "[127.0.0.1]" / localhost.
// webhostbox's outbound filter silently dropped every such mail (757 sends, 0 delivered, Oct–Nov 2026).
// Starts a tiny fake SMTP server on localhost, lets EmailSenderService connect with its real transport
// options, and records the EHLO line it receives. No network, no DB writes, nothing sent.
// Usage: node scripts/test_smtp_ehlo.js
const net = require('net');
const path = require('path');
process.env.OUTBOUND_DRY_RUN = 'true';
const EmailSenderService = require(path.join(__dirname, '..', 'services', 'emailSenderService'));
const nodemailer = require('nodemailer');

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); if (!ok) failed++; };

function fakeSmtp() {
  return new Promise((resolve) => {
    const seen = [];
    const server = net.createServer((sock) => {
      sock.write('220 fake.test ESMTP\r\n');
      sock.on('data', (buf) => {
        for (const line of buf.toString().split('\r\n').filter(Boolean)) {
          seen.push(line);
          if (/^(EHLO|HELO)/i.test(line)) sock.write('250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (/^AUTH/i.test(line)) sock.write('235 ok\r\n');
          else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

(async () => {
  const cfg = { host: '127.0.0.1', port: 2525, user: 'u@example.com', pass: 'x', secure: false };
  const opts = EmailSenderService.smtpTransportOptions(cfg);
  check('transport options set an EHLO name', Boolean(opts.name), opts.name);
  check('EHLO name is not localhost / an IP literal', !/localhost|127\.0\.0\.1|^\[/.test(opts.name || ''), opts.name);
  check('EHLO name is a dotted hostname', /\./.test(opts.name || ''));
  check('port 465 → SSL', EmailSenderService.smtpTransportOptions({ ...cfg, port: 465, secure: false }).secure === true);
  check('port 587 → STARTTLS', EmailSenderService.smtpTransportOptions({ ...cfg, port: 587, secure: true }).secure === false);

  const { server, port, seen } = await fakeSmtp();
  try {
    const t = nodemailer.createTransport({ ...EmailSenderService.smtpTransportOptions({ ...cfg, port }), ignoreTLS: true });
    await t.verify().catch(() => {});
    const ehlo = seen.find((l) => /^EHLO/i.test(l)) || '';
    check('server received EHLO with our name', ehlo === `EHLO ${opts.name}`, JSON.stringify(ehlo));
    check('server never received [127.0.0.1]', !seen.some((l) => /^(EHLO|HELO)\s*\[?127\.0\.0\.1/i.test(l)));
  } finally {
    server.close();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
