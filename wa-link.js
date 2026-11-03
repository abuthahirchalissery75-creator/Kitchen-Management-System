'use strict';
/**
 * "Link a phone" WhatsApp sender (unofficial, WhatsApp Web protocol via Baileys).
 * The admin scans a QR code once (WhatsApp > Linked devices) and the server then sends
 * messages from that WhatsApp account automatically. Session is kept in ./data/wa-auth.
 */
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const SEND_GAP_MS = 2500; // pause between messages: bursts look like spam to WhatsApp

module.exports = function createLink({ dir, onChange }) {
  const state = { status: 'idle', qr: null, number: '', error: '' };
  let sock = null, starting = false, stopped = false, retryTimer = null;
  let queue = Promise.resolve();

  const set = (patch) => { Object.assign(state, patch); try { onChange && onChange(); } catch (_) {} };
  const hasSession = () => fs.existsSync(path.join(dir, 'creds.json'));

  async function start() {
    if (starting || state.status === 'connected') return;
    starting = true; stopped = false; clearTimeout(retryTimer);
    set({ status: 'starting', error: '' });
    try {
      const baileys = await import('@whiskeysockets/baileys');
      const makeWASocket = baileys.default && baileys.default.default ? baileys.default.default : (baileys.default || baileys.makeWASocket);
      const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;
      const logger = require('pino')({ level: 'silent' });
      fs.mkdirSync(dir, { recursive: true });
      const { state: auth, saveCreds } = await useMultiFileAuthState(dir);
      let version;
      try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) { /* use library default */ }

      sock = makeWASocket({ auth, logger, version, browser: Browsers ? Browsers.macOS('Chrome') : undefined, markOnlineOnConnect: false, syncFullHistory: false });
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) {
          try { set({ status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 280 }) }); } catch (e) { set({ status: 'error', error: e.message }); }
        }
        if (connection === 'open') {
          const id = (sock.user && sock.user.id) || '';
          set({ status: 'connected', qr: null, number: id.split(':')[0].split('@')[0], error: '' });
          console.log('WhatsApp linked as +' + state.number);
        }
        if (connection === 'close') {
          const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
          sock = null; starting = false;
          if (code === DisconnectReason.loggedOut) {            // unlinked from the phone
            fs.rmSync(dir, { recursive: true, force: true });
            set({ status: 'idle', qr: null, number: '', error: 'Logged out from phone. Link again to continue.' });
          } else if (!stopped) {                                // network drop / restart required: reconnect
            set({ status: 'starting' });
            retryTimer = setTimeout(start, code === DisconnectReason.restartRequired ? 500 : 5000);
          }
        }
      });
    } catch (e) {
      sock = null;
      console.error('WhatsApp link error:', e.message);
      set({ status: 'error', error: e.message });
    } finally { starting = false; }
  }

  async function logout() {
    stopped = true; clearTimeout(retryTimer);
    try { if (sock) await sock.logout(); } catch (_) { /* already closed */ }
    try { if (sock) sock.end(undefined); } catch (_) {}
    sock = null;
    fs.rmSync(dir, { recursive: true, force: true });
    set({ status: 'idle', qr: null, number: '', error: '' });
  }

  /** Queued so messages go out one at a time with a gap. Resolves {ok, error}. */
  function send(phone, text) {
    const job = queue.then(async () => {
      if (state.status !== 'connected' || !sock) return { ok: false, error: 'WhatsApp is not linked' };
      try {
        const jid = String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
        const found = await sock.onWhatsApp(jid);
        if (!found || !found[0] || !found[0].exists) return { ok: false, error: 'That number is not on WhatsApp' };
        await sock.sendMessage(found[0].jid, { text });
        await new Promise((r) => setTimeout(r, SEND_GAP_MS));
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    });
    queue = job.catch(() => {});
    return job;
  }

  return {
    state: () => ({ ...state }),
    connected: () => state.status === 'connected',
    hasSession, start, logout, send,
  };
};
