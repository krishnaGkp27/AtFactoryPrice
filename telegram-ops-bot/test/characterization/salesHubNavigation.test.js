'use strict';
/**
 * NAV-1 (owner, 03-Oct-2026: "check if there is a card with no back
 * navigation … make a complete analysis and fix the navigation").
 *
 * Drives EVERY tile under Sales & Marketing (Orders, Marketers, Designs)
 * through the real controller as an admin, follows every non-navigation
 * button three taps deep, and fails on any screen whose keyboard has no
 * Back / Close / Cancel / Menu button (or no keyboard at all). Destructive
 * taps (deactivate) are skipped so one path cannot blank the data for the
 * next. Seeded fake sheets give every list something to show.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
process.env.ADMIN_IDS = '777'; process.env.EMPLOYEE_IDS = 'abdul,musa';
const { createFakeBot } = require(ROOT + '/test/helpers/fakeBot');
const { createFakeSheets } = require(ROOT + '/test/helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require(ROOT + '/test/helpers/controllerHarness');
const INV_H = ['PackageNo','Indent','CSNo','Design','Shade','ThanNo','Yards','Status','Warehouse','PricePerYard','DateReceived','SoldTo','SoldDate','NetMtrs','NetWeight','UpdatedAt','ProductType','bale_uid','addedAt','grn_id','bin_location','arrival_batch','design_category'];
const inv = (pkg, design, shade, than, status, wh, soldTo = '', soldDate = '') => [pkg, 'IND1', '', design, shade, than, 30, status, wh, 1500, '2026-03-01', soldTo, soldDate, '', '', '', 'fabric', `BAL-${pkg}-${than}`, '2026-03-01', '', '', 'Mar26', 'TR'];
const seed = {
  Inventory: [INV_H, inv('5801','9006','3',1,'available','Lagos'), inv('5801','9006','3',2,'available','Lagos'), inv('5802','9006','5',1,'available','Lagos'), inv('5803','9006','3',1,'sold','Lagos','ABBA','2026-09-12'), inv('5901','9032','1',1,'available','Kano office'), inv('5902','9032','1',1,'sold','Kano office','ABBA','2026-09-20')],
  Customers: [['customer_id','name','phone','address','category','credit_limit','outstanding_balance','payment_terms','notes','status','created_at','updated_at','x'], ['C1','ABBA','0802','Lagos','Wholesale',0,0,'','','Active','',''], ['C2','Ayubal Ansari','0805','Kano','Retail',0,0,'','','Active','','']],
  Orders: [['order_id','design','shade','customer','quantity','salesperson_id','salesperson_name','payment_status','scheduled_date','status','created_by','created_at','accepted_at','delivered_at','reminder_sent'], ['O1','9006','3','ABBA','2','abdul','Abdul','Paid','2026-10-05','accepted','777','2026-10-01','2026-10-02','',''], ['O2','9032','1','Ayubal Ansari','1','777','Krishna','Not yet paid','2026-10-06','pending','777','2026-10-01','','','']],
  DesignAssets: [['Design','ProductType','ShadeCount','ShadeNamesJSON','RawDriveFileId','RawDriveUrl','LabeledDriveFileId','LabeledDriveUrl','TelegramFileId','Status','UploadedBy','UploadedAt','ApprovalRequestId','ApprovedBy','Notes','Container'], ['9006','fabric','2','[{"n":3,"t":"Navy"},{"n":5,"t":"Red"}]','','','','','FILE9006','active','777','2026-08-01','','777','','Mar26'], ['9032','fabric','1','[{"n":1,"t":"White"}]','','','','','FILE9032','active','777','2026-08-01','','777','','Mar26']],
  Marketers: [['MarketerId','Name','Phone','Area','PersonPhotoFileId','PersonPhotoDriveId','CatalogPhotoFileId','CatalogPhotoDriveId','Status','ApprovedBy','ApprovalRequestId','Notes','CreatedAt'], ['M1','Musa Marketer','0803','Kano','','','','','active','777','R3','','2026-08-01']],
  CatalogStock: [['Design','CatalogSize','Warehouse','TotalQty','InOfficeQty','WithCustomersQty','WithMarketersQty','UpdatedAt'], ['9006','Big','Lagos',12,9,1,2,''], ['9006','Small','Lagos',30,22,4,4,'']],
  CatalogLedger: [['LedgerId','Design','CatalogSize','Warehouse','Quantity','Action','RecipientType','RecipientName','Status','DateOut','DateReturned','RequestedBy','ApprovedBy','ApprovalRequestId','Notes','CreatedAt'], ['L1','9006','Big','Lagos',1,'supply','customer','ABBA','active','2026-09-12','','abdul','777','R1','','2026-09-12'], ['L2','9006','Small','Lagos',2,'loan','marketer','Musa Marketer','active','2026-09-20','','abdul','777','R2','','2026-09-20']],
  MarketerAllocations: [['marketer_id','marketer_name','design','allocated_qty','updated_by','updated_at','notes','shade'], ['M1','Musa Marketer','9006','2','777','2026-09-01','','']],
  Users: [['user_id','name','role','branch','access_level','status','created_at','departments','warehouses','manages','notification_prefs','store_sales_places'], ['777','Krishna','admin','Lagos','all','active','','','Lagos,Kano office','','',''], ['abdul','Abdul','employee','Kano','branch_only','active','','Dispatch','Kano office','','','']],
  Settings: [['key','value','notes']], Departments: [['dept_id','dept_name','allowed_activities','status','created_at','parent_department','warehouses']], Locations: [['name','location','kind','status','notes','updated_by','updated_at']],
};
installFakeSheets(createFakeSheets(seed));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();
const sessionStore = require(SRC + '/utils/sessionStore');
const productTypesRepo = require(SRC + '/repositories/productTypesRepository');
productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
const auditLogRepository = require(SRC + '/repositories/auditLogRepository'); auditLogRepository.append = async () => {};
try { require(SRC + '/services/vision/driveBackup').archiveFile = async () => ({ drive: { webViewLink: '' }, readableName: 'f.jpg' }); } catch (_) {}
const logger = require(SRC + '/utils/logger'); for (const k of ['error','warn','info','debug']) logger[k] = () => {};

function wrap() {
  const fb = createFakeBot(); const rec = [];
  const bot = new Proxy(fb, { get(t, k) {
    const v = t[k]; if (typeof v !== 'function' || !['sendMessage','editMessageText','sendPhoto','editMessageCaption','editMessageReplyMarkup','sendMediaGroup','sendDocument'].includes(k)) return v;
    return async (...a) => { const r = await v.apply(t, a); rec.push({ method: k, args: a, result: r }); return r; };
  } });
  return { bot, rec };
}
const SKIP = /deact|replace|dap:cancel|dam:back|cms:back/;
const NAV = /(^|[\s(])(back|close|cancel|menu|done|exit|finish)\b|⬅|◀|🏠|❌|↩|✖|🔙/i;
const isNav = (b) => /^act:__(back|hub)__/.test(b.callback_data || '') || NAV.test(b.text || '');
function lastScreen(rec) {
  for (let i = rec.length - 1; i >= 0; i--) {
    const c = rec[i]; const a = c.args; let opts, text, mid;
    if (c.method === 'sendMessage') { text = a[1]; opts = a[2]; mid = c.result && c.result.message_id; }
    else if (c.method === 'editMessageText') { text = a[0]; opts = a[1]; mid = opts && opts.message_id; }
    else if (c.method === 'sendPhoto' || c.method === 'sendDocument') { opts = a[2]; text = (opts && opts.caption) || '[photo]'; mid = c.result && c.result.message_id; }
    else if (c.method === 'editMessageCaption') { text = a[0]; opts = a[1]; mid = opts && opts.message_id; }
    else if (c.method === 'editMessageReplyMarkup') { opts = { reply_markup: a[0], message_id: a[1] && a[1].message_id }; text = '[markup edit]'; mid = opts.message_id; }
    const kb = opts && opts.reply_markup && opts.reply_markup.inline_keyboard;
    if (kb) return { text: String(text || ''), kb: kb.flat(), mid, method: c.method };
    if (c.method === 'sendMessage') return { text: String(text || ''), kb: [], mid, method: c.method };
  }
  return null;
}
const cb = (data, uid, mid) => ({ id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: mid || 5 } });
const TILES = ['supply_request','create_order','my_orders','mark_delivered','bundle_sale','sell_bale','register_marketer','supply_catalog','loan_catalog','return_catalog','catalog_tracker','manage_catalog_stock','allocate_marketer','upload_design_photo','manage_design_photos','shade_photos','browse_catalog','search_design_photo','catalog_stats','set_design_category'];
const UID = '777';
async function replay(path) {
  sessionStore.clear(UID);
  const { bot, rec } = wrap();
  let mid = 5;
  for (const data of path) {
    rec.length = 0;
    await controller.handleCallbackQuery(bot, cb(data, UID, mid)).catch((e) => rec.push({ method: 'sendMessage', args: [UID, `[CRASH ${e.message}]`, {}], result: { message_id: mid } }));
    const s = lastScreen(rec); if (s && s.mid) mid = s.mid;
  }
  return { screen: lastScreen(rec), raw: rec };
}
test('NAV-1: every Sales & Marketing screen has a way back', async () => {
  const findings = []; const seen = new Set(); let screens = 0;
  for (const tile of TILES) {
    const budget = { n: 0 };
    async function dfs(path, depth) {
      if (budget.n >= 40) return;
      const { screen } = await replay(path);
      budget.n += 1; screens += 1;
      if (!screen) { findings.push(`${tile}: ${path.join(' > ')} rendered nothing`); return; }
      const key = tile + '|' + screen.text.split('\n')[0].slice(0, 60) + '|' + screen.kb.map((b) => b.text).join(',');
      if (!screen.kb.some(isNav) && !seen.has(key)) {
        seen.add(key);
        findings.push(`${tile}: ${path.join(' > ')} → "${screen.text.split('\n')[0].slice(0, 70)}" buttons=[${screen.kb.map((b) => b.text).join(' | ')}]`);
      }
      if (depth >= 3) return;
      const next = screen.kb.filter((b) => b.callback_data && !isNav(b) && !/noop|^act:/.test(b.callback_data) && !SKIP.test(b.callback_data) && !/prev|next|◀|▶|\d+\/\d+/i.test(b.text)).slice(0, 7);
      for (const b of next) await dfs([...path, b.callback_data], depth + 1);
    }
    await dfs([`act:${tile}`], 0);
  }
  assert.ok(screens >= 100, `crawl too shallow: ${screens} screens`);
  assert.deepEqual(findings, [], `screens with no way back:\n${findings.join('\n')}`);
});
