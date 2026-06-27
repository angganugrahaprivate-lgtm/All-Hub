require('dotenv').config();
const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios    = require('axios');
const cron     = require('node-cron');

const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const SHEET_ID         = process.env.GOOGLE_SHEETS_ID;       // GSheet Master ID
const FONNTE_TOKEN     = process.env.FONNTE_TOKEN;
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_NOTIF_CHAT_ID;
const YOUR_WA_NUMBER   = process.env.YOUR_WA_NUMBER;
const BOT_MENTION      = (process.env.BOT_MENTION_NAME || 'masterops').toLowerCase();
const BOT_WA_NUMBER    = process.env.BOT_WA_NUMBER || '';
const REMINDER_TARGETS = (process.env.REMINDER_TARGETS || '').split(',').filter(Boolean);
const PORT             = process.env.PORT || 3001;

// Sheet names di GSheet Master
const SHEETS = {
  palembang : 'standar palembang',
  cikarang  : 'standar cikarang',
  // Tambah cabang lain di sini nanti
};

const ALL_CABANG = Object.keys(SHEETS);

console.log('=== ENV CHECK ===');
console.log('ANTHROPIC_API_KEY :', ANTHROPIC_KEY    ? 'OK' : 'MISSING');
console.log('GOOGLE_SHEETS_ID  :', SHEET_ID         ? 'OK' : 'MISSING');
console.log('FONNTE_TOKEN      :', FONNTE_TOKEN      ? 'OK' : 'MISSING');
console.log('TELEGRAM_TOKEN    :', TELEGRAM_TOKEN    ? 'OK' : 'MISSING');
console.log('BOT_MENTION       :', BOT_MENTION);
console.log('=================');

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─── COLUMN MAPPING (format standar master) ───────────────
// A=NoOrder B=ShippingNumber C=Tanggal D=Koli E=NamaCustomer
// F=Alamat G=Kecamatan H=Kota I=NoTelepon J=Resi
// K=Status L=Remark M=Ekspedisi N=Driver O=ETA/SLA
const COL = {
  noOrder   : 0,   // A
  shippingNum: 1,  // B
  tanggal   : 2,   // C
  koli      : 3,   // D
  customer  : 4,   // E
  alamat    : 5,   // F
  kecamatan : 6,   // G
  kota      : 7,   // H
  telepon   : 8,   // I
  resi      : 9,   // J
  status    : 10,  // K
  remark    : 11,  // L
  ekspedisi : 12,  // M
  driver    : 13,  // N
  sla       : 14,  // O — ETA/SLA
};

const COL_NAMES = ['No Order','Shipping Number','Tanggal','Koli','Nama Customer','Alamat','Kecamatan','Kota','No. Telepon','Resi','Status','Remark','Ekspedisi','Driver','ETA/SLA'];

// ─── CACHE (1 JAM) ────────────────────────────────────────
const cache    = {};
const CACHE_TTL = 60 * 60 * 1000;
function getCache(key)       { const c = cache[key]; if (c && Date.now() - c.time < CACHE_TTL) return c.data; return null; }
function setCache(key, data) { cache[key] = { data, time: Date.now() }; }
function clearCache(key)     { if (key) delete cache[key]; else Object.keys(cache).forEach(k => delete cache[k]); }

// ─── GOOGLE SHEETS ────────────────────────────────────────
let sheetsClient = null;
let sheetsInitPromise = null;

async function getSheets() {
  if (sheetsClient) return sheetsClient;
  if (!sheetsInitPromise) {
    sheetsInitPromise = (async () => {
      try {
        const { google } = require('googleapis');
        const auth = new google.auth.GoogleAuth({
          credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        sheetsClient = google.sheets({ version: 'v4', auth });
        console.log('Google Sheets OK');
        return sheetsClient;
      } catch (e) {
        sheetsInitPromise = null;
        console.error('Sheets init error:', e.message);
        return null;
      }
    })();
  }
  return sheetsInitPromise;
}

function getToday() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' }); }

function parseDate(s) {
  if (!s) return '';
  s = s.toString().trim();
  const mon = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,mei:5,maret:3,april:4,juni:6,juli:7,agustus:8,oktober:10,november:11,desember:12 };
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return s;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  m = s.match(/(\d{1,2})\s*[-\s]+\s*([a-zA-Z]+)\s*[-\s]+\s*(\d{4})/);
  if (m) { const mn = mon[m[2].toLowerCase().trim().substring(0,3)]; if (mn) return `${m[3]}-${String(mn).padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  return s;
}

function formatDateID(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric', timeZone:'Asia/Jakarta' });
}

// ─── AMBIL DATA PER CABANG ────────────────────────────────
async function getSheetData(cabang) {
  const sheetName = SHEETS[cabang];
  if (!sheetName) return null;
  const cacheKey = `sheetData_${cabang}`;
  const cached = getCache(cacheKey);
  if (cached) { console.log(`Cache hit: ${cacheKey}`); return cached; }
  const s = await getSheets(); if (!s) return null;
  try {
    const res = await s.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${sheetName}!A:O` });
    const data = res.data.values || [];
    setCache(cacheKey, data);
    console.log(`Sheet [${cabang}] loaded: ${data.length} rows`);
    return data;
  } catch (e) { console.error(`getSheetData [${cabang}] error:`, e.message); return null; }
}

// Ambil data dari semua cabang sekaligus
async function getAllCabangData() {
  const results = {};
  await Promise.all(ALL_CABANG.map(async (cabang) => {
    results[cabang] = await getSheetData(cabang);
  }));
  return results;
}

function rowToObj(row) {
  const obj = {};
  COL_NAMES.forEach((name, i) => { obj[name] = (row[i] || ''); });
  return obj;
}

// ─── DETECT CABANG DARI PESAN ─────────────────────────────
function detectCabang(message) {
  const msg = (message || '').toLowerCase();
  for (const cabang of ALL_CABANG) {
    if (msg.includes(cabang)) return cabang;
  }
  return null; // semua cabang
}

// ─── FILTER DATA ──────────────────────────────────────────
function filterData(data, intent, message) {
  if (!data || data.length < 2) return [];
  const rows = data.slice(1);
  const today = getToday();
  let filtered;
  switch (intent) {
    case 'pending':
      filtered = rows.filter(r => /pending|waiting/i.test(r[COL.status] || ''));
      break;
    case 'no_resi':
      filtered = rows.filter(r => !(r[COL.resi] || '').trim() && (r[COL.status] || '').toLowerCase() !== 'received');
      break;
    case 'overdue':
      filtered = rows.filter(r => {
        const s = r[COL.sla]; return s && parseDate(s) < today && (r[COL.status] || '').toLowerCase() !== 'received';
      });
      break;
    case 'shipped_today':
      filtered = rows.filter(r => (r[COL.tanggal] || '').startsWith(today));
      break;
    case 'specific_order': {
      const on = (message.match(/\d{6,}/) || [])[0];
      filtered = on ? rows.filter(r => (r[COL.noOrder] || '').includes(on) || (r[COL.shippingNum] || '').includes(on)) : rows.slice(-50);
      break;
    }
    case 'customer_search': {
      const words = message.split(/\s+/).filter(w => w.length > 3);
      filtered = rows.filter(r => words.some(w => (r[COL.customer] || '').toLowerCase().includes(w.toLowerCase())));
      break;
    }
    case 'ekspedisi': {
      const ekspList = ['gls','jne','j&t','jnt','sicepat','anteraja','ninja','tiki','lion','jnl','deliveree','sentral'];
      const ek = ekspList.find(k => message.toLowerCase().includes(k));
      filtered = ek ? rows.filter(r => (r[COL.ekspedisi] || '').toLowerCase().includes(ek)) : rows.slice(-100);
      break;
    }
    default:
      filtered = rows.slice(-100);
  }
  console.log(`Filter [${intent}]: ${filtered.length}/${rows.length} rows`);
  return filtered.map(rowToObj);
}

// ─── INTENT DETECTION ─────────────────────────────────────
function detectIntent(message) {
  const msg = (message || '').toLowerCase().trim();
  if (/^(halo|hai|hi|hello|selamat|pagi|siang|sore|malam|hey)/.test(msg)) return 'greeting';
  if (/^(oke|ok|tidak|ga|gak|siap|done|sip|noted|thanks|makasih)$/.test(msg)) return 'greeting';
  if (/kamu bisa|fitur apa|help|bantuan/.test(msg)) return 'help';
  if (/refresh|sync data|reload data/.test(msg)) return 'refresh';
  if (/overdue|telat|terlambat|lewat sla/.test(msg)) return 'overdue';
  if (/sla|deadline|mau deadline|mendekati|urgent/.test(msg)) return 'sla_alert';
  if (/pending|waiting|belum dikirim/.test(msg)) return 'pending';
  if (/belum.*resi|tanpa resi/.test(msg)) return 'no_resi';
  if (/summary|rangkum|rekap|laporan/.test(msg)) return 'summary';
  if (/pengiriman hari ini|shipped hari ini|dikirim hari ini/.test(msg)) return 'shipped_today';
  if (/gls|jne|j&t|jnt|sicepat|anteraja|ninja|tiki|lion|jnl|deliveree|sentral/.test(msg)) return 'ekspedisi';
  if (/\d{6,}/.test(msg)) return 'specific_order';
  if (/nama|customer|cari.*nama/.test(msg)) return 'customer_search';
  if (/out of scope|diluar konteks/.test(msg)) return 'out_of_scope';
  return 'general';
}

// ─── MESSAGING ────────────────────────────────────────────
async function sendTelegram(chatId, message) {
  try { await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: chatId, text: message }); }
  catch (e) { console.error('sendTelegram error:', e.response?.data || e.message); }
}

async function sendWA(target, message, mentions = []) {
  try {
    const payload = { target, message };
    if (mentions.length > 0) payload.mentions = mentions.join(',');
    await axios.post('https://api.fonnte.com/send', payload, { headers: { Authorization: FONNTE_TOKEN } });
  } catch (e) { console.error('sendWA error:', e.message); }
}

async function sendToTargets(message) {
  const targets = [...REMINDER_TARGETS];
  if (YOUR_WA_NUMBER && !targets.includes(YOUR_WA_NUMBER)) targets.push(YOUR_WA_NUMBER);
  for (const num of targets) await sendWA(num, message);
  if (TELEGRAM_CHAT_ID) await sendTelegram(TELEGRAM_CHAT_ID, message);
}

// ─── SYSTEM PROMPT ────────────────────────────────────────
const SYSTEM_PROMPT = `
Kamu adalah MasterOps — asisten operasional logistik multi-cabang Dekoruma.
Bahasa: Indonesia casual. Nada: Santai, friendly, tapi tetap profesional.
Kamu punya akses ke data order dari semua cabang via tools.

## CABANG YANG TERSEDIA
${ALL_CABANG.map(c => `- ${c.charAt(0).toUpperCase() + c.slice(1)}`).join('\n')}

## KEPRIBADIAN
- Ngobrol ringan itu oke, tapi tetap fokus ke konteks ops logistik
- Proaktif: kalau lihat ada yang perlu diperhatikan, sebutin
- Kalau ditanya tentang cabang tertentu, fokus ke cabang itu
- Kalau tidak disebutkan cabang, cari di semua cabang dan tampilkan per cabang
- Jangan bilang "saya tidak bisa" kalau ada tool yang bisa bantu

## KEMAMPUAN (via tools)
- Cek & monitor order per cabang atau lintas cabang
- Summary, SLA, overdue, pending, belum resi
- Cari order by nomor, nama customer, ekspedisi
- Rekap perbandingan antar cabang

## FORMAT OUTPUT MULTI-CABANG
Kalau data dari beberapa cabang, tampilkan per cabang:

📦 PALEMBANG
• ...

📦 CIKARANG  
• ...

## ATURAN
- Kalau di luar konteks ops logistik → "Hmmm gatau sih, diluar konteks itu keknya 😅"
- Selalu sebut nama cabang saat menampilkan data
`.trim();

// ─── TOOLS ────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_order_data',
    description: 'Ambil data order dari GSheet Master. Bisa filter by cabang (palembang/cikarang/semua) dan intent.',
    input_schema: {
      type: 'object',
      properties: {
        cabang: {
          type: 'string',
          description: 'Nama cabang: palembang, cikarang, atau semua untuk semua cabang',
          enum: [...ALL_CABANG, 'semua'],
        },
        intent: {
          type: 'string',
          description: 'Jenis filter: summary, overdue, no_resi, pending, shipped_today, specific_order, customer_search, ekspedisi, general',
          enum: ['summary','overdue','no_resi','pending','shipped_today','specific_order','customer_search','ekspedisi','general'],
        },
        query: {
          type: 'string',
          description: 'Query tambahan: nomor order, nama customer, atau nama ekspedisi',
        },
      },
      required: ['cabang', 'intent'],
    },
  },
  {
    name: 'get_summary_all',
    description: 'Ambil ringkasan operasional dari semua cabang sekaligus untuk perbandingan.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ─── TOOL EXECUTOR ────────────────────────────────────────
async function executeTool(toolName, toolInput) {
  console.log(`[Tool] ${toolName}:`, JSON.stringify(toolInput));
  try {
    switch (toolName) {

      case 'get_order_data': {
        const cabang = toolInput.cabang;
        const intent = toolInput.intent;
        const query  = toolInput.query || '';

        if (cabang === 'semua') {
          // Cari di semua cabang
          const allData = await getAllCabangData();
          const results = {};
          for (const [cab, data] of Object.entries(allData)) {
            if (!data) continue;
            const rows = filterData(data, intent, query);
            if (rows.length > 0) results[cab] = rows.slice(0, 30);
          }
          return { results, total: Object.values(results).reduce((s, r) => s + r.length, 0) };
        } else {
          const data = await getSheetData(cabang);
          if (!data) return { error: `Data cabang ${cabang} tidak tersedia` };
          const rows = filterData(data, intent, query);
          return { cabang, rows: rows.slice(0, 50), total: rows.length };
        }
      }

      case 'get_summary_all': {
        const today   = getToday();
        const allData = await getAllCabangData();
        const summary = {};
        for (const [cabang, data] of Object.entries(allData)) {
          if (!data || data.length < 2) { summary[cabang] = { error: 'Tidak ada data' }; continue; }
          const rows = data.slice(1);
          summary[cabang] = {
            total     : rows.length,
            received  : rows.filter(r => (r[COL.status]||'').toLowerCase().includes('received')).length,
            pending   : rows.filter(r => /pending|waiting/i.test(r[COL.status]||'')).length,
            noResi    : rows.filter(r => !(r[COL.resi]||'').trim() && (r[COL.status]||'').toLowerCase() !== 'received').length,
            kirimHariIni: rows.filter(r => (r[COL.tanggal]||'').startsWith(today)).length,
          };
        }
        return { summary, tanggal: today };
      }

      default:
        return { error: `Tool tidak dikenal: ${toolName}` };
    }
  } catch (e) {
    console.error(`[Tool Error] ${toolName}:`, e.message);
    return { error: e.message };
  }
}

// ─── CLAUDE CALL ──────────────────────────────────────────
const chatHistory = {};
const HISTORY_MAX = 200;

async function callClaude(senderId, senderName, userMessage) {
  const today  = getToday();
  const intent = detectIntent(userMessage);

  if (intent === 'greeting') return 'Halo! Ada yang bisa dibantu? 😊';
  if (intent === 'help') return `Halo! Aku *MasterOps* — asisten multi-cabang Dekoruma.\n\nBisa bantu:\n• Cek order by nomor, nama, atau ekspedisi\n• Summary & rekap per cabang\n• Monitor overdue, pending, belum resi\n• Bandingkan data antar cabang\n\nContoh:\n• "cek order 9247412"\n• "summary palembang"\n• "pending cikarang"\n• "rekap semua cabang"`;
  if (intent === 'refresh') { clearCache(); return '🔄 Data semua cabang berhasil di-refresh!'; }
  if (intent === 'out_of_scope') return 'Hmmm gatau sih, diluar konteks itu keknya 😅';

  if (!chatHistory[senderId]) chatHistory[senderId] = [];
  const messages = [...chatHistory[senderId]];
  messages.push({ role: 'user', content: `Tanggal: ${today}\nUser: ${senderName}\n\n${userMessage}` });

  let finalReply = '';
  let loopCount  = 0;
  const MAX_LOOPS = 5;

  while (loopCount < MAX_LOOPS) {
    loopCount++;
    const response = await anthropic.messages.create({
      model     : 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system    : [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools     : TOOLS,
      messages,
    });

    const usage = response.usage;
    console.log(`[Tokens L${loopCount}] in:${usage.input_tokens} out:${usage.output_tokens} cache_read:${usage.cache_read_input_tokens||0}`);

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      finalReply = textBlock ? textBlock.text : '';
      messages.push({ role: 'assistant', content: response.content });
      break;
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults   = await Promise.all(
        toolUseBlocks.map(async (block) => ({
          type        : 'tool_result',
          tool_use_id : block.id,
          content     : JSON.stringify(await executeTool(block.name, block.input)),
        }))
      );
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
    break;
  }

  // Simpan history
  chatHistory[senderId].push({ role: 'user',      content: userMessage });
  chatHistory[senderId].push({ role: 'assistant', content: finalReply  });
  if (chatHistory[senderId].length > 12) chatHistory[senderId] = chatHistory[senderId].slice(-12);
  if (Object.keys(chatHistory).length > HISTORY_MAX) delete chatHistory[Object.keys(chatHistory)[0]];

  return finalReply.trim();
}

// ─── HELPER: CEK MENTION BOT ──────────────────────────────
function isBotMentioned(message) {
  const msg = (message || '').toLowerCase();
  if (msg.includes(`@${BOT_MENTION}`)) return true;
  if (BOT_WA_NUMBER) {
    const num = BOT_WA_NUMBER.replace(/\D/g, '');
    const variants = [num, num.replace(/^62/,'0'), num.replace(/^62/,''), num.replace(/^0/,'62')];
    for (const v of variants) { if (v && message.includes(`@${v}`)) return true; }
  }
  return false;
}

// ─── WEBHOOKS ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status:'ok', agent:'master-ops', cabang: ALL_CABANG, time_wib: new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'}) }));
app.get('/webhook/telegram', (_, res) => res.sendStatus(200));
app.get('/webhook/wa', (_, res) => res.sendStatus(200));

// Telegram
app.post('/webhook/telegram', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body.message || req.body.edited_message; if (!msg) return;
  const chatId    = msg.chat.id;
  const firstName = msg.from?.first_name || 'User';
  const senderId  = `tg_${chatId}`;
  const text      = msg.text || msg.caption || '';
  if (!text) return;
  console.log(`TG [${firstName}]: ${text.substring(0,80)}`);
  try { await sendTelegram(chatId, await callClaude(senderId, firstName, text)); }
  catch (e) { console.error('TG error:', e.message); await sendTelegram(chatId, 'Maaf, error: ' + e.message); }
});

// WhatsApp
app.post('/webhook/wa', async (req, res) => {
  res.sendStatus(200);
  const { sender, message, name, member } = req.body;
  if (!sender || !message) return;
  const isGroup   = sender.includes('@g.us');
  const senderName = name || member || sender;
  const senderId   = `wa_${sender}`;
  console.log(`WA [${senderName}${isGroup?'/GROUP':''}]: "${(message||'').substring(0,60)}"`);
  try {
    if (isGroup) {
      if (!isBotMentioned(message)) return;
      const cleanMsg = message.replace(new RegExp(`@${BOT_MENTION}`, 'gi'), '').trim();
      const mentionPrefix = member ? `@${member} ` : '';
      const mentionArr    = member ? [member] : [];
      await sendWA(sender, mentionPrefix + await callClaude(senderId, senderName, cleanMsg), mentionArr);
      return;
    }
    await sendWA(sender, await callClaude(senderId, senderName, message));
  } catch (e) { console.error('WA error:', e.message); await sendWA(sender, 'Maaf, error: ' + e.message); }
});

// ─── SCHEDULER — Pagi summary semua cabang ────────────────
cron.schedule('0 8 * * *', async () => {
  console.log('=== SCHEDULER 08:00 — Summary Multi-Cabang ===');
  try {
    clearCache();
    const today   = getToday();
    const allData = await getAllCabangData();
    let msg = `📊 *SUMMARY HARIAN MULTI-CABANG*\n📅 ${formatDateID(today)}\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const [cabang, data] of Object.entries(allData)) {
      if (!data || data.length < 2) { msg += `📍 *${cabang.toUpperCase()}*\n_Data tidak tersedia_\n\n`; continue; }
      const rows = data.slice(1);
      const received  = rows.filter(r => (r[COL.status]||'').toLowerCase().includes('received')).length;
      const pending   = rows.filter(r => /pending|waiting/i.test(r[COL.status]||'')).length;
      const noResi    = rows.filter(r => !(r[COL.resi]||'').trim() && (r[COL.status]||'').toLowerCase() !== 'received').length;
      const kirimHariIni = rows.filter(r => (r[COL.tanggal]||'').startsWith(today)).length;
      msg += `📍 *${cabang.toUpperCase()}*\n`;
      msg += `• Total order  : ${rows.length}\n`;
      msg += `• Received     : ${received}\n`;
      msg += `• Kirim hari ini: ${kirimHariIni}\n`;
      msg += `• Pending      : ${pending}\n`;
      msg += `• Belum resi   : ${noResi}\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━━━━\n🤖 _MasterOps — Dekoruma_`;
    await sendToTargets(msg);
  } catch (e) { console.error('Scheduler error:', e.message); }
}, { timezone: 'Asia/Jakarta' });

// ─── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`MasterOps Agent running on port ${PORT}`);
  console.log(`Cabang: ${ALL_CABANG.join(', ')}`);
  console.log(`BOT_MENTION: @${BOT_MENTION}`);
});
