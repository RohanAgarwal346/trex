'use strict';
// Ropo Tally Bridge - run this on the PC where Tally is open (Tally: F1 > Settings > Connectivity > "Tally acts as: Server/Both", port 9000).
// It pulls receipts entered by staff from the Ropo server and posts them into Tally as Receipt vouchers,
// and sends the Tally customer (Sundry Debtors) list back to the app. Zero dependencies, Node 18+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const cfgPath = process.argv[2] || path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) { console.error(`Missing ${cfgPath}. Copy config.example.json to config.json and fill it in.`); process.exit(1); }
const cfg = { tallyHost: '127.0.0.1', tallyPort: 9000, pollSeconds: 20, ledgerSyncMinutes: 10, partyGroups: ['Sundry Debtors'], voucherType: 'Receipt', ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
const SERVER = String(cfg.serverUrl || '').replace(/\/+$/, '');
if (!SERVER || !cfg.bridgeKey) { console.error('config.json needs serverUrl and bridgeKey (see the Settings tab of the admin panel).'); process.exit(1); }

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => (n < 32 ? '' : String.fromCodePoint(+n))).replace(/&amp;/g, '&');
const amt = (n) => (Math.round(n * 100) / 100).toFixed(2);
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

function tally(xml) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(xml, 'utf8');
    const req = http.request({ host: cfg.tallyHost, port: cfg.tallyPort, method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', 'content-length': body.length }, timeout: 30000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); resolve(b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8')); });
    });
    req.on('timeout', () => req.destroy(new Error('Tally did not answer (is it open with a company loaded?)')));
    req.on('error', (e) => reject(new Error(`Cannot reach Tally at ${cfg.tallyHost}:${cfg.tallyPort} - ${e.message}`)));
    req.end(body);
  });
}
async function api(method, p, body) {
  const r = await fetch(SERVER + p, { method, headers: { 'content-type': 'application/json', 'x-bridge-key': cfg.bridgeKey }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${j.error || r.status}`); return j;
}

const tallyDate = (d) => d.replace(/-/g, '');
function receiptXml(r, ledgers, company) {
  const mode = ledgers[r.mode] || 'Cash';
  const bills = r.bills || [];
  const billed = bills.reduce((s, b) => s + b.amount, 0), rest = r.amount - billed;
  const alloc = [...bills.map((b) => `<BILLALLOCATIONS.LIST><NAME>${esc(b.ref)}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>${amt(b.amount)}</AMOUNT></BILLALLOCATIONS.LIST>`),
    ...(rest > 0.004 ? [`<BILLALLOCATIONS.LIST><NAME>Receipt-App-${r.id}</NAME><BILLTYPE>On Account</BILLTYPE><AMOUNT>${amt(rest)}</AMOUNT></BILLALLOCATIONS.LIST>`] : [])].join('');
  const narration = `${r.narration ? r.narration + ' | ' : ''}Collected by ${r.staff} via Ropo app [#${r.id}]${r.mode !== 'cash' ? ' (' + r.mode.toUpperCase() + ')' : ''}`;
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>` +
    `<STATICVARIABLES>${company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : ''}</STATICVARIABLES></REQUESTDESC><REQUESTDATA>` +
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="ropo-receipt-${r.id}" VCHTYPE="${esc(cfg.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
    `<DATE>${tallyDate(r.vdate)}</DATE><VOUCHERTYPENAME>${esc(cfg.voucherType)}</VOUCHERTYPENAME><PARTYLEDGERNAME>${esc(r.party)}</PARTYLEDGERNAME>` +
    `<NARRATION>${esc(narration)}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>` +
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(r.party)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amt(r.amount)}</AMOUNT>${alloc}</ALLLEDGERENTRIES.LIST>` +
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(mode)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amt(r.amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>` +
    `</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}
function parseImport(resp) {
  const n = (tag) => { const m = new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`).exec(resp); return m ? +m[1] : 0; };
  const created = n('CREATED') + n('ALTERED'), errors = n('ERRORS');
  const line = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/.exec(resp);
  if (created > 0 && !errors) return { ok: true, voucher_no: (/<LASTVCHID>\s*(\d+)/.exec(resp) || [])[1] };
  return { ok: false, error: line ? unesc(line[1]).trim() : (/<DESC>[\s\S]*?<\/DESC>/.test(resp) || errors ? `Tally rejected the voucher (errors=${errors})` : `Unexpected reply from Tally: ${resp.slice(0, 200)}`) };
}

async function pushReceipts() {
  const { receipts, mode_ledgers, company } = await api('GET', '/api/bridge/pending');
  for (const r of receipts) {
    let result;
    try { result = parseImport(await tally(receiptXml(r, mode_ledgers, company || cfg.company))); } catch (e) { result = { ok: false, error: e.message }; }
    log(result.ok ? `OK   receipt #${r.id} ${r.party} Rs.${r.amount}` : `FAIL receipt #${r.id} ${r.party}: ${result.error}`);
    if (!result.ok && /Cannot reach Tally|did not answer/.test(result.error)) break; // Tally is down: leave the rest pending and retry next round
    await api('POST', '/api/bridge/ack', { id: r.id, ...result });
  }
}
async function pushLedgers() {
  const names = new Set();
  for (const g of cfg.partyGroups) {
    const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>RopoParties</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
      `${cfg.company ? `<SVCURRENTCOMPANY>${esc(cfg.company)}</SVCURRENTCOMPANY>` : ''}</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="RopoParties" ISMODIFY="No"><TYPE>Ledger</TYPE><CHILDOF>${esc(g)}</CHILDOF><BELONGSTO>Yes</BELONGSTO><FETCH>Name</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    const resp = await tally(xml);
    for (const m of resp.matchAll(/<LEDGER\b[^>]*?\sNAME="([^"]+)"/g)) names.add(unesc(m[1]).trim());
  }
  if (!names.size) { log('No customers found in Tally (check partyGroups in config.json)'); return; }
  const out = await api('POST', '/api/bridge/ledgers', { names: [...names] }); log(`Synced ${out.count} customers from Tally`);
}

let lastLedgers = 0, busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    if (Date.now() - lastLedgers > cfg.ledgerSyncMinutes * 60000) { try { await pushLedgers(); lastLedgers = Date.now(); } catch (e) { log('Customer sync:', e.message); } }
    await pushReceipts();
  } catch (e) { log('Error:', e.message); } finally { busy = false; }
}
if (process.argv.includes('--test-xml')) { console.log(receiptXml({ id: 1, vdate: '2026-11-02', party: 'Phoolchand & Sons', amount: 5000, mode: 'cash', bills: [{ ref: 'INV-1', amount: 2000 }], narration: '', staff: 'Ramesh' }, { cash: 'Cash' }, '')); process.exit(0); }
log(`Ropo Tally Bridge started. Server: ${SERVER}  Tally: ${cfg.tallyHost}:${cfg.tallyPort}`);
tick(); setInterval(tick, cfg.pollSeconds * 1000);
