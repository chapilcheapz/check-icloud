require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const path = require('path');
const sharp = require('sharp');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Gemini Vision API cho captcha
const { GoogleGenerativeAI } = require('@google/generative-ai');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY_HERE';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const resultCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

const userAgents = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// === FREE PROXY ROTATION SYSTEM ===
// LƯU Ý: Proxy miễn phí thường không ổn định, đặt enabled: true để thử
const FREE_PROXY_CONFIG = {
  enabled: false, // Tắt mặc định vì proxy miễn phí hay bị fail
  refreshInterval: 30 * 60 * 1000, // Refresh proxy list mỗi 30 phút
  maxProxies: 20, // Giữ tối đa 20 proxy
  testTimeout: 5000, // Timeout khi test proxy (5 giây)
  apis: [
    'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
    'https://www.proxy-list.download/api/v1/get?type=https',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt'
  ]
};

let proxyList = [];
let lastProxyRefresh = 0;
let proxyIndex = 0;

// Fetch proxies từ các API miễn phí
async function fetchFreeProxies() {
  console.log('🔄 Đang fetch proxy miễn phí...');
  const allProxies = new Set();

  for (const apiUrl of FREE_PROXY_CONFIG.apis) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(apiUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': userAgents[0] }
      });
      clearTimeout(timeoutId);

      const text = await response.text();
      const proxies = text.split(/[\r\n]+/)
        .map(p => p.trim())
        .filter(p => p && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(p));

      proxies.forEach(p => allProxies.add(`http://${p}`));
      console.log(`  ✓ ${apiUrl.substring(0, 50)}... → ${proxies.length} proxies`);
    } catch (err) {
      console.log(`  ✗ ${apiUrl.substring(0, 50)}... → Lỗi: ${err.message}`);
    }
  }

  // Chọn ngẫu nhiên một số proxy để test
  const proxyArray = Array.from(allProxies);
  const shuffled = proxyArray.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, FREE_PROXY_CONFIG.maxProxies);

  console.log(`📦 Tổng: ${allProxies.size} proxies, chọn ${selected.length} để sử dụng`);

  proxyList = selected;
  lastProxyRefresh = Date.now();
  proxyIndex = 0;

  return selected;
}

// Lấy proxy tiếp theo (round-robin)
async function getNextProxy() {
  // Refresh list nếu cần
  if (FREE_PROXY_CONFIG.enabled &&
    (proxyList.length === 0 || Date.now() - lastProxyRefresh > FREE_PROXY_CONFIG.refreshInterval)) {
    await fetchFreeProxies();
  }

  if (!FREE_PROXY_CONFIG.enabled || proxyList.length === 0) {
    return null;
  }

  // Round-robin
  const proxy = proxyList[proxyIndex % proxyList.length];
  proxyIndex++;

  return proxy;
}

// Hàm cũ getProxy() để tương thích
async function getProxy() {
  return await getNextProxy();
}

function randomDelay(min, max) {
  return new Promise(r => setTimeout(r, Math.random() * (max - min) + min));
}

// === HÀM GIẢI CAPTCHA BẰNG GEMINI VISION ===
async function solveCaptcha(imagePath, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🔍 Đang giải captcha bằng Gemini Vision (lần ${attempt})...`);

      // Enhance ảnh: zoom 3x, tăng contrast
      const enhancedPath = imagePath.replace('.png', '_enhanced.png');
      await sharp(imagePath)
        .resize({ width: 300 })  // Zoom to ~3x (captcha thường ~100px)
        .sharpen()               // Làm sắc nét
        .normalise()             // Tăng contrast
        .toFile(enhancedPath);

      console.log('✓ Đã enhance ảnh captcha');

      // Đọc ảnh enhanced và convert sang base64
      const imageData = fs.readFileSync(enhancedPath);
      const base64Image = imageData.toString('base64');

      // Gọi Gemini Vision
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: 'image/png',
            data: base64Image
          }
        },
        'Read the text in this captcha image. Return ONLY the characters/text you see, nothing else. No explanation, just the captcha text.'
      ]);

      const response = await result.response;
      const text = response.text().trim();

      // Làm sạch text: bỏ khoảng trắng, chỉ giữ chữ và số
      const cleanText = text.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      console.log(`✓ Gemini captcha: "${text}" -> "${cleanText}"`);
      return cleanText;
    } catch (err) {
      console.error(`✗ Lỗi Gemini captcha (lần ${attempt}):`, err.message);
      if (attempt < retries && err.message.includes('503')) {
        console.log('⏳ Đợi 2 giây rồi thử lại...');
        await new Promise(r => setTimeout(r, 2000));
      } else if (attempt >= retries) {
        return null;
      }
    }
  }
  return null;
}
async function crawlIunlocker(serial) {
  const cached = resultCache.get(serial);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`Lấy từ cache: ${serial}`);
    return cached.data;
  }

  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

  const proxy = await getProxy();

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
      })
    ]);

    await randomDelay(5000, 8000);

    const data = await page.evaluate(() => {
      const result = {};

      const modelEl = document.querySelector('.iuResCard_model');
      if (modelEl) {
        result['Model'] = modelEl.textContent.trim();
      }

      const rows = document.querySelectorAll('.iuResCard_row');
      rows.forEach(row => {
        const labelEl = row.querySelector('.iuResCard_label');
        const valueEl = row.querySelector('.iuResCard_value');

        if (labelEl && valueEl) {
          let label = labelEl.textContent.trim();
          let value = valueEl.textContent.trim();

          if (!label || label === ' ' || value === 'Check here' || value.includes('Click to buy')) {
            return;
          }

          if (label.toLowerCase().includes('icloud')) {
            return;
          }

          if (label.toLowerCase().includes('provided by')) {
            return;
          }

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

      if (Object.keys(result).length === 0) {
        const allText = document.body.innerText;

        if (allText.includes('giới hạn') || allText.includes('limit') || allText.includes('thử lại sau') || allText.includes('try again')) {
          result.rateLimited = true;
          result.error = 'Đã đạt giới hạn. Vui lòng thử lại sau vài phút.';
        }
        else if (allText.includes('Invalid') || allText.includes('không hợp lệ') || allText.includes('not found')) {
          result.error = 'Serial/IMEI không hợp lệ hoặc không tìm thấy';
        }
      }

      return result;
    });

    await browser.close();

    if (data.rateLimited) {
      return { error: data.error, rateLimited: true };
    }

    if (Object.keys(data).length === 0) {
      return { error: 'Không tìm thấy thông tin. Vui lòng kiểm tra lại Serial/IMEI.' };
    }

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

  const proxy = await getProxy();

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

    await page.waitForSelector('#imei', { timeout: 10000 });
    for (const char of serial) {
      await page.type('#imei', char, { delay: 50 + Math.random() * 80 });
    }

    await randomDelay(500, 1500);

    await Promise.all([
      page.click('a.button-go'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => { })
    ]);

    await randomDelay(5000, 8000);

    const icloudData = await page.evaluate(() => {
      const hiddenInput = document.querySelector('#out_t');
      if (hiddenInput && hiddenInput.value) {
        const value = hiddenInput.value;

        const icloudLockMatch = value.match(/iCloud Lock:\s*(ON|OFF)/i);
        const icloudLock = icloudLockMatch ? icloudLockMatch[1].toUpperCase() : null;

        if (icloudLock) {
          return {
            icloudLock,
            source: 'hidden_input'
          };
        }
      }

      const allText = document.body.innerText;

      if (allText.includes('giới hạn') || allText.includes('limit') || allText.includes('thử lại sau')) {
        return { error: 'rate_limit' };
      }

      const textMatch = allText.match(/iCloud Lock[:\s]+(ON|OFF)/i);
      if (textMatch) {
        return {
          icloudLock: textMatch[1].toUpperCase(),
          source: 'page_text'
        };
      }

      const icloudElements = document.querySelectorAll('[class*="icloud"], [class*="result"], [class*="status"]');
      for (const el of icloudElements) {
        const text = el.textContent;
        if (text.includes('ON') || text.includes('OFF')) {
          const match = text.match(/(ON|OFF)/);
          if (match) {
            return {
              icloudLock: match[1].toUpperCase(),
              source: 'element_search'
            };
          }
        }
      }

      return {
        error: 'not_found',
        debug: allText.substring(0, 500)
      };
    });

    await browser.close();

    if (icloudData) {
      console.log('iCloud crawl result:', JSON.stringify(icloudData));
    }

    return icloudData;

  } catch (err) {
    await browser.close();
    console.error('Lỗi crawl iCloud:', err.message);
    return null;
  }
}

// === CRAWL XIAOMI IMEI TỪ MIFIRM.NET ===
async function crawlXiaomi(imei) {
  console.log(`Đang kiểm tra Xiaomi IMEI: ${imei}`);

  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  const proxy = await getProxy();

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
    console.log(`Sử dụng proxy: ${proxy}`);
  }

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(userAgent);

    await randomDelay(1000, 2000);

    // Thử load trang, bỏ qua timeout nếu trang load chậm
    try {
      await page.goto('https://mifirm.net/imei', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    } catch (navErr) {
      console.log('Timeout khi load trang, tiếp tục...');
    }

    // Chờ JavaScript render form
    await randomDelay(5000, 7000);

    // Chọn service "Xiaomi IMEI information checker" từ dropdown
    try {
      await page.waitForSelector('#service_select', { timeout: 10000 });
      await page.select('#service_select', 'check_imei');
      console.log('✓ Đã chọn service check_imei');
    } catch (e) {
      console.log('✗ Không tìm thấy #service_select:', e.message);
      // Chụp screenshot debug
      await page.screenshot({ path: '/tmp/mifirm_debug.png' });
      console.log('Screenshot saved: /tmp/mifirm_debug.png');
    }

    await randomDelay(500, 1000);

    // Nhập IMEI vào input field
    try {
      await page.waitForSelector('#imeiInput', { timeout: 10000 });
      await page.click('#imeiInput', { clickCount: 3 });
      for (const char of imei) {
        await page.type('#imeiInput', char, { delay: 30 + Math.random() * 50 });
      }
      console.log('✓ Đã nhập IMEI');
    } catch (e) {
      console.log('✗ Không tìm thấy #imeiInput:', e.message);
    }

    await randomDelay(500, 1000);

    // Click nút Check
    try {
      await page.click('#checkimei');
      console.log('✓ Đã click nút Check');
    } catch (e) {
      console.log('✗ Không tìm thấy #checkimei:', e.message);
    }

    // Chờ xem có captcha không
    await randomDelay(2000, 3000);

    // Kiểm tra captcha bằng cách tìm element #captchaIMEI_img
    const captchaImgSrc = await page.evaluate(() => {
      const captchaImg = document.querySelector('#captchaIMEI_img');
      return captchaImg ? captchaImg.src : null;
    });

    if (captchaImgSrc) {
      console.log('🔒 Phát hiện captcha:', captchaImgSrc);

      const captchaPath = '/tmp/mifirm_captcha.png';

      try {
        // Download ảnh captcha từ URL
        const captchaResponse = await page.evaluate(async (src) => {
          const response = await fetch(src);
          const blob = await response.blob();
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        }, captchaImgSrc);

        // Lưu ảnh captcha
        const base64Data = captchaResponse.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(captchaPath, base64Data, 'base64');
        console.log('✓ Đã download captcha image');

        // Giải captcha bằng OCR
        const captchaSolution = await solveCaptcha(captchaPath);

        if (captchaSolution) {
          // Nhập vào input captcha
          await page.waitForSelector('#captchaIMEI_input', { timeout: 5000 });
          await page.click('#captchaIMEI_input', { clickCount: 3 });
          await page.type('#captchaIMEI_input', captchaSolution, { delay: 50 });
          console.log(`✓ Đã nhập captcha: ${captchaSolution}`);

          // Click nút Check trong modal
          await page.click('.modal-content button[type="submit"]');
          console.log('✓ Đã submit captcha');

          // Chờ kết quả
          await randomDelay(5000, 7000);
        }
      } catch (captchaErr) {
        console.log('✗ Lỗi xử lý captcha:', captchaErr.message);
      }
    } else {
      console.log('✓ Không có captcha, chờ kết quả...');
    }

    // Chờ thêm để kết quả load
    await randomDelay(3000, 5000);

    // Chụp screenshot kết quả
    await page.screenshot({ path: '/tmp/mifirm_result.png' });
    console.log('Screenshot kết quả saved: /tmp/mifirm_result.png');

    // Parse kết quả từ mifirm.net
    const data = await page.evaluate(() => {
      const result = {};

      // Lấy toàn bộ text của trang
      const bodyText = document.body.innerText;

      // Parse các trường cụ thể từ mifirm.net - tìm trong block kết quả
      const resultSection = bodyText.substring(
        bodyText.indexOf('IMEI number:'),
        bodyText.indexOf('Unlock Mi account lock')
      );

      if (resultSection) {
        // Parse từ result section
        const imeiMatch = resultSection.match(/IMEI\s*number[:\s]+(\d{15,17})/i);
        if (imeiMatch) result['IMEI'] = imeiMatch[1];

        const productMatch = resultSection.match(/Product\s*name[:\s]+(.+)/i);
        if (productMatch) result['Product Name'] = productMatch[1].trim();

        const dateMatch = resultSection.match(/Manufacture\s*date[:\s]+(.+)/i);
        if (dateMatch) result['Manufacture Date'] = dateMatch[1].trim();

        const countryMatch = resultSection.match(/Country[:\s]+(.+)/i);
        if (countryMatch) result['Country'] = countryMatch[1].trim();
      }

      // Kiểm tra lỗi
      if (bodyText.toLowerCase().includes('not found') ||
        bodyText.toLowerCase().includes('invalid') ||
        bodyText.toLowerCase().includes('không tìm thấy')) {
        result.error = 'IMEI không hợp lệ hoặc không tìm thấy';
      }

      return result;
    });

    console.log('Parsed data:', JSON.stringify(data));

    await browser.close();
    return data;

  } catch (err) {
    await browser.close();
    console.error('Lỗi crawl Xiaomi:', err.message);
    return { error: `Lỗi: ${err.message}` };
  }
}

const app = express();
app.use(express.static('public'));
app.use(express.json());

const modelPhonePath = path.join(__dirname, 'modelPhone.json');
let models = {};
try {
  models = JSON.parse(fs.readFileSync(modelPhonePath, 'utf8'));
} catch (err) {
  console.error('LỖI: Không đọc được modelPhone.json');
  process.exit(1);
}

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

// === ROUTE: /check-xiaomi ===
app.post('/check-xiaomi', async (req, res) => {
  const { imei } = req.body;

  if (!imei || imei.length < 15) {
    return res.status(400).json({
      success: false,
      error: 'IMEI không hợp lệ (cần 15 số)'
    });
  }

  try {
    const data = await crawlXiaomi(imei);

    if (data.error) {
      return res.status(400).json({ success: false, error: data.error });
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Không tìm thấy thông tin. Vui lòng kiểm tra lại IMEI.'
      });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('Lỗi crawl Xiaomi:', err.message);
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