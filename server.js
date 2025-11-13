const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const path = require('path');

// === KHỞI TẠO APP TRƯỚC ===
const app = express();
app.use(express.static('public'));
app.use(express.json());

// === ĐỌC modelPhone.json ===
const modelPhonePath = path.join(__dirname, 'modelPhone.json');
let models = {};
try {
  models = JSON.parse(fs.readFileSync(modelPhonePath, 'utf8'));
} catch (err) {
  console.error('LỖI: Không đọc được modelPhone.json');
  process.exit(1);
}

// === HÀM LẤY THÔNG TIN MÁY ===
function getDeviceInfo(productType, modelNumber) {
  const device = models[productType];
  if (!device) {
    return { name: productType || 'Unknown', storage: 'Unknown' };
  }
  const storage = modelNumber && device.modelNumbers[modelNumber]
    ? device.modelNumbers[modelNumber]
    : 'Unknown';
  return { name: device.name, storage };
}

// === CHẠY LỆNH ===
function runCmd(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      const output = stdout || stderr || err?.message || '';
      resolve({ ok: !err, out: output.trim() });
    });
  });
}

// === PHÂN TÍCH ideviceinfo ===
function parseInfo(output) {
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const res = {};
  lines.forEach(line => {
    const idx = line.indexOf(':');
    if (idx > -1) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      res[key] = val;
    }
  });

  // === iCLOUD ===
  let icloud = 'UNKNOWN';
  const fmLocked = res['fm-activation-locked'];
  if (fmLocked === 'Tk8=') icloud = 'OFF';
  else if (fmLocked === 'WUVT') icloud = 'ON';
  else if (res['PasswordProtected'] === 'true') icloud = 'ON';
  else if (res['PasswordProtected'] === 'false') icloud = 'OFF';

  const device = getDeviceInfo(res['ProductType'], res['ModelNumber']);

  return {
    model: device,
    name: res['DeviceName'] || 'iPhone',
    udid: res['UniqueDeviceID'] || res['Unique Device ID'] || null,
    serial: res['SerialNumber'] || null,
    imei1: res['InternationalMobileEquipmentIdentity'] || null,
    imei2: res['InternationalMobileEquipmentIdentity2'] || null,
    icloud: icloud
  };
}

// === ROUTE: /check ===
app.post('/check', async (req, res) => {
  const steps = [];

  // 1. Unpair
  steps.push({ step: 'Unpair', status: 'running' });
  const unpair = await runCmd('idevicepair unpair', 10000);
  steps[steps.length - 1].status = unpair.ok ? 'ok' : 'error';
  steps[steps.length - 1].output = unpair.out;

  // 2. Pair
  steps.push({ step: 'Pair', status: 'running' });
  const pair = await runCmd('idevicepair pair', 20000);
  steps[steps.length - 1].status = pair.ok ? 'ok' : 'error';
  steps[steps.length - 1].output = pair.out;

  if (!pair.ok || !/SUCCESS/i.test(pair.out)) {
    steps.push({
      step: 'Hướng dẫn',
      status: 'info',
      output: 'Vui lòng mở khóa iPhone và bấm "Tin cậy máy tính này". Sau đó thử lại.'
    });
  }

  await new Promise(r => setTimeout(r, 3000));

  // 3. Get Info
  steps.push({ step: 'Lấy thông tin', status: 'running' });
  const info = await runCmd('ideviceinfo', 15000);
  steps[steps.length - 1].status = info.ok ? 'ok' : 'error';
  steps[steps.length - 1].output = info.out;

  let parsed = {};
  if (info.ok) {
    parsed = parseInfo(info.out);
  } else {
    steps.push({
      step: 'Lỗi',
      status: 'error',
      output: 'Không kết nối được. Kiểm tra cáp, mở khóa iPhone, bấm "Tin cậy".'
    });
  }

  res.json({ steps, info: parsed });
});

// === ROUTE: /pdf ===
app.get('/pdf', (req, res) => {
  const {
    modelName = 'iPhone',
    storage = 'Unknown',
    name = 'Không đặt tên',
    udid = '',
    serial = '',
    icloud = 'UNKNOWN'
  } = req.query;

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const filename = `iphone-${serial || 'check'}.pdf`;
  res.setHeader('Content-disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-type', 'application/pdf');
  doc.pipe(res);

  doc.fontSize(24).font('Helvetica-Bold').fillColor('#007AFF')
     .text('BÁO CÁO KIỂM TRA iPHONE', { align: 'center' });
  doc.moveDown();

  const items = [
    ['Tên máy', modelName],
    ['Dung lượng', storage],
    ['Tên thiết bị', name],
    ['Serial', serial],
    ['UDID', udid],
    ['iCloud / Find My', 
     icloud === 'ON' ? 'ON (CÓ TÀI KHOẢN)' : 
     icloud === 'OFF' ? 'OFF (SẠCH 100%)' : 'KHÔNG XÁC ĐỊNH']
  ];

  doc.fontSize(12).font('Helvetica');
  let y = doc.y;
  items.forEach(([label, value]) => {
    doc.fillColor('#8E8E93').text(label + ':', 50, y);
    doc.fillColor('#1C1C1E').font('Helvetica-Bold').text(value, 150, y);
    y += 25;
  });

  doc.fontSize(10).fillColor('#8E8E93')
     .text(`Báo cáo được tạo tự động – ${new Date().toLocaleString('vi-VN')}`, 50, doc.page.height - 100, { align: 'center', width: 500 });

  doc.end();
});

// === KHỞI ĐỘNG ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server chạy tại: http://localhost:${PORT}`);
});