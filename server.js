const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const path = require('path');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const resultCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

const userAgents = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

const TOR_CONFIG = {
  enabled: false,
  proxy: 'socks5://127.0.0.1:9050'
};

const PROXY_CONFIG = {
  enabled: false,
  list: [
    // 'http://proxy1.example.com:8080',
    // 'socks5://127.0.0.1:1080'
  ]
};

function getProxy() {
  if (TOR_CONFIG.enabled) {
    return TOR_CONFIG.proxy;
  }
  if (PROXY_CONFIG.enabled && PROXY_CONFIG.list.length > 0) {
    return PROXY_CONFIG.list[Math.floor(Math.random() * PROXY_CONFIG.list.length)];
  }
  return null;
}

function randomDelay(min, max) {
  return new Promise(r => setTimeout(r, Math.random() * (max - min) + min));
}
async function crawlIunlocker(serial) {
  const cached = resultCache.get(serial);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`Lấy từ cache: ${serial}`);
    return cached.data;
  }

  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

  const proxy = getProxy();

  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  };

  if (proxy) {
    launchOptions.args.push(`--proxy-server=${proxy}`);
    console.log(`Sử dụng proxy: ${proxy.replace(/\/\/.*:.*@/, '//***:***@')}`);
  } else {
    console.log('Sử dụng system proxy (VPN nếu đang bật)');
    console.log('Sử dụng system proxy (VPN nếu đang bật)');
  }

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.setViewport({
      width: 1280 + Math.floor(Math.random() * 100),
      height: 800 + Math.floor(Math.random() * 100)
    });
    await page.setUserAgent(userAgent);

    await randomDelay(2000, 5000);

    await page.goto('https://iunlocker.com/vi/check_imei.php', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Random delay sau khi load (1-3 giây)
    await randomDelay(1000, 3000);

    // Nhập serial vào input
    await page.waitForSelector('#imei', { timeout: 10000 });

    // Gõ với tốc độ ngẫu nhiên giống người thật
    for (const char of serial) {
      await page.type('#imei', char, { delay: 50 + Math.random() * 100 });
    }

    // Random delay trước khi click (0.5-2 giây)
    await randomDelay(500, 2000);

    // Click nút Kiểm tra và chờ navigation hoặc content thay đổi
    await Promise.all([
      page.click('a.button-go'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {
        // Fallback: nếu không có navigation, chờ thêm
      })
    ]);

    // Chờ thêm để đảm bảo content đã load (5-8 giây)
    await randomDelay(5000, 8000);

    // Parse kết quả - dùng CSS selectors từ iunlocker.com
    const data = await page.evaluate(() => {
      const result = {};

      // === LẤY MODEL TỪ CLASS .iuResCard_model ===
      const modelEl = document.querySelector('.iuResCard_model');
      if (modelEl) {
        result['Model'] = modelEl.textContent.trim();
      }

      // === LẤY CÁC TRƯỜNG TỪ .iuResCard_row ===
      const rows = document.querySelectorAll('.iuResCard_row');
      rows.forEach(row => {
        const labelEl = row.querySelector('.iuResCard_label');
        const valueEl = row.querySelector('.iuResCard_value');

        if (labelEl && valueEl) {
          let label = labelEl.textContent.trim();
          let value = valueEl.textContent.trim();

          // Bỏ qua các trường không cần thiết
          if (!label || label === ' ' || value === 'Check here' || value.includes('Click to buy')) {
            return;
          }

          // Bỏ qua iCloud (cần trả phí)
          if (label.toLowerCase().includes('icloud')) {
            return;
          }

          // Bỏ qua provider info
          if (label.toLowerCase().includes('provided by')) {
            return;
          }

          // Normalize labels sang tiếng Việt
          const labelMap = {
            'Số sê-ri': 'Serial',
            'Past First Activation': 'Đã kích hoạt',
            'Apple Care': 'Apple Care',
            'Warranty Name': 'Bảo hành',
            'Estimated Expiration Date': 'Ngày hết hạn',
            'Service & Support Options': 'Dịch vụ hỗ trợ',
            'Sold By | Carrier | SIMLock': 'SIM Lock'
          };

          const normalizedLabel = labelMap[label] || label;
          result[normalizedLabel] = value;
        }
      });

      // === FALLBACK: Tìm trong innerText nếu không có kết quả ===
      if (Object.keys(result).length === 0) {
        const allText = document.body.innerText;

        // Kiểm tra rate limit
        if (allText.includes('giới hạn') || allText.includes('limit') || allText.includes('thử lại sau') || allText.includes('try again')) {
          result.rateLimited = true;
          result.error = 'Đã đạt giới hạn. Vui lòng thử lại sau vài phút.';
        }
        // Kiểm tra lỗi khác
        else if (allText.includes('Invalid') || allText.includes('không hợp lệ') || allText.includes('not found')) {
          result.error = 'Serial/IMEI không hợp lệ hoặc không tìm thấy';
        }
      }

      return result;
    });

    await browser.close();

    // Kiểm tra rate limit
    if (data.rateLimited) {
      return { error: data.error, rateLimited: true };
    }

    // Nếu không lấy được gì, trả về lỗi
    if (Object.keys(data).length === 0) {
      return { error: 'Không tìm thấy thông tin. Vui lòng kiểm tra lại Serial/IMEI.' };
    }

    // Lưu vào cache nếu có kết quả hợp lệ
    if (!data.error && Object.keys(data).length > 1) {
      resultCache.set(serial, { data, timestamp: Date.now() });
      console.log(`Đã cache kết quả: ${serial}`);
    }

    return data;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// === CRAWL ICLOUD STATUS TỪ IUNLOCKER.COM ===
async function crawlIcloudStatus(serial) {
  // Random user agent
  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

  const proxy = getProxy();

  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  };

  if (proxy) {
    launchOptions.args.push(`--proxy-server=${proxy}`);
  }

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.setViewport({
      width: 1280 + Math.floor(Math.random() * 100),
      height: 800 + Math.floor(Math.random() * 100)
    });
    await page.setUserAgent(userAgent);

    // Random delay
    await randomDelay(1000, 2000);

    await page.goto('https://iunlocker.com/vi/check_icloud.php', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await randomDelay(1000, 2000);

    // Nhập serial
    await page.waitForSelector('#imei', { timeout: 10000 });
    for (const char of serial) {
      await page.type('#imei', char, { delay: 50 + Math.random() * 80 });
    }

    await randomDelay(500, 1500);

    // Click nút Kiểm tra
    await Promise.all([
      page.click('a.button-go'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => { })
    ]);

    await randomDelay(3000, 5000);

    // Lấy giá trị từ hidden input #out_t
    const icloudData = await page.evaluate(() => {
      const hiddenInput = document.querySelector('#out_t');
      if (hiddenInput && hiddenInput.value) {
        const value = hiddenInput.value;

        // Parse iCloud Lock
        const icloudLockMatch = value.match(/iCloud Lock:\s*(ON|OFF)/i);
        const icloudLock = icloudLockMatch ? icloudLockMatch[1].toUpperCase() : null;

        // Parse iCloud Status
        const icloudStatusMatch = value.match(/iCloud Status:\s*([^\n]+)/i);
        const icloudStatus = icloudStatusMatch ? icloudStatusMatch[1].trim() : null;

        return {
          icloudLock,
          icloudStatus,
          raw: value
        };
      }

      // Kiểm tra rate limit
      const allText = document.body.innerText;
      if (allText.includes('giới hạn') || allText.includes('limit') || allText.includes('thử lại sau')) {
        return { error: 'rate_limit' };
      }

      return null;
    });

    await browser.close();
    return icloudData;

  } catch (err) {
    await browser.close();
    console.error('Lỗi crawl iCloud:', err.message);
    return null;
  }
}

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

  // Base64 decode helper
  const decode = (v) => {
    try { return Buffer.from(v, 'base64').toString('utf8'); }
    catch { return v; }
  };

  const fmLockedRaw = res['fm-activation-locked'];
  const fmLocked = decode(fmLockedRaw);     // "YES", "NO", hoặc nonsense
  const fmEmailRaw = res['fm-account-masked'];
  const fmEmail = fmEmailRaw ? decode(fmEmailRaw) : null;
  const fmStatusRaw = res['fm-spstatus'];
  const fmStatus = fmStatusRaw ? decode(fmStatusRaw) : null;

  // --- Logic check iCloud FULL ---
  if (fmLocked === 'YES' || fmStatus === 'YES') {

    if (fmEmail && fmEmail.length > 0) {
      // Có email → iCloud locked rõ ràng
      icloud = 'ON';
    } else {
      // Không có email → iCloud ẩn (vẫn khóa vì fmLocked=YES)
      icloud = 'ON_HIDDEN';
    }

  } else if (fmLocked === 'NO') {

    // fmLocked = NO → Find My OFF (trừ khi PasswordProtected ghi đè)
    icloud = 'OFF';

  } else {
    // Fallback: dùng PasswordProtected
    if (res['PasswordProtected'] === 'true') icloud = 'ON';
    else if (res['PasswordProtected'] === 'false') icloud = 'OFF';
  }

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

// === ROUTE: /check-serial ===
app.post('/check-serial', async (req, res) => {
  const { serial } = req.body;

  if (!serial || serial.length < 8) {
    return res.status(400).json({
      success: false,
      error: 'Serial/IMEI không hợp lệ (tối thiểu 8 ký tự)'
    });
  }

  try {
    console.log(`Đang kiểm tra serial: ${serial}`);

    // Chạy song song cả hai crawl
    const [imeiData, icloudData] = await Promise.all([
      crawlIunlocker(serial),
      crawlIcloudStatus(serial)
    ]);

    // Xử lý lỗi từ IMEI check
    if (imeiData.error) {
      return res.status(400).json({ success: false, error: imeiData.error });
    }

    // Merge kết quả iCloud vào data
    if (icloudData && icloudData.icloudLock) {
      imeiData['iCloud Lock'] = icloudData.icloudLock;
      console.log(`iCloud Lock: ${icloudData.icloudLock}`);
    } else {
      imeiData['iCloud Lock'] = 'Không xác định';
    }

    res.json({ success: true, data: imeiData });
  } catch (err) {
    console.error('Lỗi crawl:', err.message);
    res.status(500).json({
      success: false,
      error: 'Không thể lấy dữ liệu. Vui lòng thử lại sau.'
    });
  }
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