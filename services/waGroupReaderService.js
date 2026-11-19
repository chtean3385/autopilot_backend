// Opportunity Hunter — WhatsApp group/channel READER (2026-11-19, _docs/opportunity-hunter.md).
//
// The Meta Cloud API (our WABA) cannot see groups or channels, so this logs in as a linked device
// (Baileys, like WhatsApp Web) on a SPARE number the owner scans a QR for. Never the WABA number,
// never the owner's personal number.
//
// READ-ONLY by design: this file never calls sendMessage / any send API. It only joins the group or
// channel links the owner adds, listens to group messages live, and pulls each channel's latest posts
// every 10 minutes (channel posts also arrive live once followed; the pull is the safety net).
// Every post from a watched source goes to opportunityHunterService.ingestMessage → the worker.
//
// Login state lives on disk (OPP_READER_AUTH_DIR, default ~/.autoagent-wa-reader) — outside the git
// checkout so deploys (git reset --hard) never log it out. Turned on by Connect on the Opportunities
// page (OPP_READER_ENABLED = true, so it reconnects on every server start); Disconnect logs out.

const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const pool = require('../config/db');
const { getSetting, setSetting } = require('./settingsService');
const channelHealth = require('../utils/channelHealth');
const { isDryRun } = require('../utils/dryRun');
const hunter = require('./opportunityHunterService');

const AUTH_DIR = process.env.OPP_READER_AUTH_DIR || path.join(os.homedir(), '.autoagent-wa-reader');
const CHANNEL_POLL_MS = 10 * 60 * 1000;
const JOIN_GAP_MS = 20 * 1000;            // joins are spaced out — bursts of joins look like spam to WhatsApp
const MAX_POST_AGE_MS = 3 * 24 * 3600 * 1000; // history synced on login: ignore posts older than 3 days

const state = { status: 'off', qr: null, me: null, error: null, connectedAt: null, lastMessageAt: null };
let sock = null;
let baileys = null;
let reconnectTimer = null;
let reconnectDelay = 5000;
let pollTimer = null;
let joining = false;
let stopping = false;
let sourcesByJid = new Map();
let sourcesLoadedAt = 0;

function log(...a) { console.log('[WAReader]', ...a); }

async function loadBaileys() {
  if (!baileys) baileys = await import('@whiskeysockets/baileys'); // ESM-only package
  return baileys;
}

async function refreshSources(force = false) {
  if (!force && Date.now() - sourcesLoadedAt < 60 * 1000) return;
  const { rows } = await pool.query(`SELECT * FROM opportunity_sources WHERE jid IS NOT NULL`);
  sourcesByJid = new Map(rows.map((r) => [r.jid, r]));
  sourcesLoadedAt = Date.now();
}

function messageText(message) {
  if (!message) return '';
  const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message.viewOnceMessageV2?.message
    || message.documentWithCaptionMessage?.message || message.editedMessage?.message || message;
  return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption
    || m.documentMessage?.caption || '').trim();
}

async function handleIncoming(msg) {
  const jid = msg?.key?.remoteJid || '';
  if (!jid.endsWith('@g.us') && !jid.endsWith('@newsletter')) return;
  if (msg.key.fromMe) return;
  await refreshSources();
  const source = sourcesByJid.get(jid);
  if (!source || !source.active) return;
  const text = messageText(msg.message);
  if (!text) return;
  const ts = Number(msg.messageTimestamp) * 1000 || Date.now();
  if (Date.now() - ts > MAX_POST_AGE_MS) return;
  const id = await hunter.ingestMessage({
    sourceId: source.id, chatJid: jid, waMessageId: msg.key.id,
    sender: msg.key.participantAlt || msg.key.participant || msg.participant || null, text, receivedAt: new Date(ts),
  });
  if (id) {
    state.lastMessageAt = new Date().toISOString();
    channelHealth.markOk('wa_reader');
  }
}

// ── Joining sources ────────────────────────────────────────────────────────────────────────────

function parseLink(link) {
  const s = String(link || '').trim();
  let m = s.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,})/i);
  if (m) return { kind: 'group', code: m[1] };
  m = s.match(/whatsapp\.com\/channel\/([A-Za-z0-9]{10,})/i);
  if (m) return { kind: 'channel', code: m[1] };
  return null;
}

async function joinSource(src) {
  if (isDryRun()) { log(`[DRY RUN] would join ${src.kind} ${src.link}`); return; }
  try {
    if (src.kind === 'group') {
      const info = await sock.groupGetInviteInfo(src.invite_code);
      let jid = info?.id;
      try {
        jid = (await sock.groupAcceptInvite(src.invite_code)) || jid;
      } catch (err) {
        // 409 / conflict = this number is already in the group — fine
        if (!/conflict|409|already/i.test(String(err?.message || err?.output?.statusCode))) throw err;
      }
      if (!jid) throw new Error('WhatsApp returned no group id');
      await pool.query(`UPDATE opportunity_sources SET jid = $2, name = COALESCE($3, name), status = 'joined', error = NULL WHERE id = $1`,
        [src.id, jid, info?.subject || null]);
    } else {
      const meta = await sock.newsletterMetadata('invite', src.invite_code);
      if (!meta?.id) throw new Error('Channel not found (link expired or wrong?)');
      try { await sock.newsletterFollow(meta.id); } catch (err) { log(`follow ${meta.id}:`, err.message); }
      const name = meta.thread_metadata?.name?.text || meta.name || null;
      await pool.query(`UPDATE opportunity_sources SET jid = $2, name = COALESCE($3, name), status = 'joined', error = NULL WHERE id = $1`,
        [src.id, meta.id, name]);
    }
    log(`joined ${src.kind} ${src.link}`);
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 250);
    log(`join ${src.link} failed:`, msg);
    await pool.query(`UPDATE opportunity_sources SET status = 'error', error = $2 WHERE id = $1`, [src.id, msg]);
  }
  await refreshSources(true);
}

async function joinPending() {
  if (joining || state.status !== 'connected') return;
  joining = true;
  try {
    const { rows } = await pool.query(`SELECT * FROM opportunity_sources WHERE status = 'pending' AND active ORDER BY id`);
    for (let i = 0; i < rows.length; i++) {
      if (state.status !== 'connected') break;
      await joinSource(rows[i]);
      if (i < rows.length - 1) await new Promise((r) => setTimeout(r, JOIN_GAP_MS));
    }
  } finally {
    joining = false;
  }
}

// ── Channel pull (safety net for live delivery) ─────────────────────────────────────────────────

function findMessageNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.tag === 'message' && Array.isArray(node.content) && node.content.some((c) => c?.tag === 'plaintext')) out.push(node);
  if (Array.isArray(node.content)) node.content.forEach((c) => findMessageNodes(c, out));
  return out;
}

async function pollChannels() {
  if (state.status !== 'connected' || !sock) return;
  const { proto } = await loadBaileys();
  const { rows } = await pool.query(`SELECT * FROM opportunity_sources WHERE kind = 'channel' AND status = 'joined' AND active AND jid IS NOT NULL`);
  for (const src of rows) {
    try {
      const res = await sock.newsletterFetchMessages(src.jid, 20);
      for (const node of findMessageNodes(res)) {
        const pt = node.content.find((c) => c.tag === 'plaintext');
        if (!pt?.content) continue;
        const buf = typeof pt.content === 'string' ? Buffer.from(pt.content, 'binary') : Buffer.from(pt.content);
        const message = proto.Message.decode(buf);
        await handleIncoming({
          key: { remoteJid: src.jid, id: node.attrs?.message_id || node.attrs?.server_id || node.attrs?.id, fromMe: false }, // id order = live delivery's → dedupes
          message, messageTimestamp: Number(node.attrs?.t) || Math.floor(Date.now() / 1000),
        });
      }
      await pool.query(`UPDATE opportunity_sources SET last_polled_at = NOW() WHERE id = $1`, [src.id]);
    } catch (err) {
      log(`poll channel ${src.name || src.jid} failed:`, err.message);
    }
  }
}

// ── Connection ─────────────────────────────────────────────────────────────────────────────────

async function connect() {
  if (sock) return;
  stopping = false;
  clearTimeout(reconnectTimer);
  state.status = 'starting';
  state.error = null;
  const B = await loadBaileys();
  const makeWASocket = B.default || B.makeWASocket;
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state: auth, saveCreds } = await B.useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await B.fetchLatestBaileysVersion()); } catch { /* library default */ }
  const pino = require('pino');

  sock = makeWASocket({
    auth,
    ...(version ? { version } : {}),
    logger: pino({ level: 'silent' }),
    browser: B.Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      state.status = 'qr';
      state.qr = await QRCode.toDataURL(u.qr).catch(() => null);
    }
    if (u.connection === 'open') {
      state.status = 'connected';
      state.qr = null;
      state.error = null;
      state.connectedAt = new Date().toISOString();
      state.me = sock?.user?.id ? String(sock.user.id).split(':')[0].split('@')[0] : null;
      reconnectDelay = 5000;
      channelHealth.markOk('wa_reader');
      log(`connected as ${state.me}`);
      refreshSources(true).catch(() => {});
      joinPending().catch((e) => log('joinPending:', e.message));
      clearInterval(pollTimer);
      pollTimer = setInterval(() => pollChannels().catch((e) => log('poll:', e.message)), CHANNEL_POLL_MS);
      setTimeout(() => pollChannels().catch(() => {}), 30 * 1000);
    }
    if (u.connection === 'close') {
      clearInterval(pollTimer);
      sock = null;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (stopping) { state.status = 'off'; return; }
      if (code === 401) { // logged out from the phone, or the session was removed
        state.status = 'logged_out';
        state.error = 'Logged out — click Connect and scan the QR again';
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        channelHealth.markError('wa_reader', 'WhatsApp reader was logged out');
        log('logged out');
        return;
      }
      if (code === 440) { // the same login opened somewhere else (e.g. a second server)
        state.status = 'error';
        state.error = 'This WhatsApp login was opened on another computer/server — only one place can run it';
        channelHealth.markError('wa_reader', state.error);
        return;
      }
      state.status = 'reconnecting';
      state.error = u.lastDisconnect?.error?.message || `closed (${code || 'unknown'})`;
      if (code !== 515) channelHealth.markError('wa_reader', `Disconnected: ${state.error}`);
      reconnectTimer = setTimeout(() => connect().catch((e) => log('reconnect:', e.message)), code === 515 ? 1000 : reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5 * 60 * 1000);
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages || []) {
      try { await handleIncoming(m); } catch (err) { log('message failed:', err.message); }
    }
  });
}

async function start() {
  await setSetting('OPP_READER_ENABLED', 'true');
  await connect();
  return getStatus();
}

// Disconnect: logOut = unlink the spare number (next Connect needs a new QR); otherwise just stop.
async function stop({ logOut = false } = {}) {
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(pollTimer);
  await setSetting('OPP_READER_ENABLED', 'false');
  const s = sock;
  sock = null;
  try {
    if (s && logOut) await s.logout();
    else if (s) s.end(undefined);
  } catch { /* already closed */ }
  if (logOut) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  Object.assign(state, { status: 'off', qr: null, error: null });
  return getStatus();
}

function getStatus() {
  return { ...state, authDir: AUTH_DIR, hasLogin: fs.existsSync(path.join(AUTH_DIR, 'creds.json')) };
}

// Add a group/channel invite link. Joined right away when connected, otherwise on the next connect.
async function addSource(link) {
  const parsed = parseLink(link);
  if (!parsed) throw new Error('Not a WhatsApp group (chat.whatsapp.com/…) or channel (whatsapp.com/channel/…) link');
  const clean = String(link).trim().split(/[?#\s]/)[0];
  const { rows } = await pool.query(
    `INSERT INTO opportunity_sources (link, kind, invite_code) VALUES ($1, $2, $3)
     ON CONFLICT (link) DO UPDATE SET active = TRUE, status = CASE WHEN opportunity_sources.status = 'error' THEN 'pending' ELSE opportunity_sources.status END
     RETURNING *`, [clean, parsed.kind, parsed.code]);
  joinPending().catch((e) => log('joinPending:', e.message));
  return rows[0];
}

// Groups this number is already in (joined by hand on the phone) → watched sources, one click.
async function importJoinedGroups() {
  if (state.status !== 'connected' || !sock) throw new Error('Connect the reader first');
  const groups = await sock.groupFetchAllParticipating();
  let added = 0;
  for (const g of Object.values(groups || {})) {
    const r = await pool.query(
      `INSERT INTO opportunity_sources (link, kind, jid, name, status) VALUES ($1, 'group', $2, $3, 'joined')
       ON CONFLICT (link) DO NOTHING RETURNING id`, [`group:${g.id}`, g.id, g.subject || null]);
    const known = await pool.query(`SELECT 1 FROM opportunity_sources WHERE jid = $1 AND link <> $2`, [g.id, `group:${g.id}`]);
    if (r.rows[0] && known.rows[0]) await pool.query(`DELETE FROM opportunity_sources WHERE id = $1`, [r.rows[0].id]);
    else if (r.rows[0]) added++;
  }
  await refreshSources(true);
  return { found: Object.keys(groups || {}).length, added };
}

async function bootIfEnabled() {
  try {
    if (String(await getSetting('OPP_READER_ENABLED')).toLowerCase() === 'true') await connect();
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    log('boot failed:', err.message);
  }
}

module.exports = { start, stop, getStatus, addSource, importJoinedGroups, bootIfEnabled, joinPending, _internal: { parseLink, messageText, findMessageNodes } };
