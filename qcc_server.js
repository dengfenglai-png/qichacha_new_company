/**
 * 企查查 - 每日新增企业爬虫（服务器版）
 *
 * 使用 Puppeteer 无头浏览器，复用浏览器登录态
 * 通过 Vue 组件翻页提取 DOM 数据，按日期过滤
 *
 * 首次部署：
 *   1. 本地: node qcc_server.js --login  （打开浏览器手动登录）
 *   2. 将 qcc_cookies.json 上传到服务器同目录
 *
 * 日常运行：
 *   node qcc_server.js                              # 今天
 *   node qcc_server.js --date 2026-05-29            # 指定日期
 *   node qcc_server.js --province SH --city 310101   # 其他区域
 *
 * 定时任务：
 *   0 9 * * 1-5 cd /opt/qcc-spider && node qcc_server.js >> cron.log 2>&1
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');

const CONFIG = {
  baseUrl: 'https://www.qcc.com',
  cookieFile: path.join(__dirname, 'qcc_cookies.json'),
  outputDir: __dirname,
  province: 'BJ',
  city: '110101',
  date: null,
  headless: 'new',
  timeout: 30000,
  maxPages: 60,
  pageDelay: 1200,
};

// ================================================================
// Cookie
// ================================================================

function normalizeCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain || '.qcc.com',
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
    expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1,
  };
}

function saveCookies(cookies) {
  fs.writeFileSync(CONFIG.cookieFile, JSON.stringify(cookies, null, 2));
  console.log(`[Cookie] 保存 ${cookies.length} 个 cookies`);
}

function parseCookieString(str) {
  // 解析 "name1=val1; name2=val2" 格式的 cookie 字符串
  return str.split(';').map(pair => {
    const [name, ...rest] = pair.trim().split('=');
    const value = rest.join('=');
    return name && value ? normalizeCookie({ name: name.trim(), value, domain: '.qcc.com' }) : null;
  }).filter(Boolean);
}

function loadCookies() {
  // 1. 优先从环境变量 QCC_COOKIE 读取（GitHub Actions 使用）
  const envCookie = process.env.QCC_COOKIE;
  if (envCookie && envCookie.length > 10) {
    const cookies = parseCookieString(envCookie);
    console.log(`[Cookie] 从环境变量 QCC_COOKIE 加载 ${cookies.length} 个 cookies`);
    // 写入文件缓存（下次运行文件不存在时仍可从 env 读取）
    try { fs.writeFileSync(CONFIG.cookieFile, JSON.stringify(cookies, null, 2)); } catch {}
    return cookies;
  }

  // 2. 从文件读取
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG.cookieFile, 'utf-8'));
    const data = raw.map(normalizeCookie);
    console.log(`[Cookie] 从文件加载 ${data.length} 个 cookies`);
    return data;
  } catch (e) {
    console.log(`[Cookie] 未找到 cookie（设置 QCC_COOKIE 环境变量或运行 --login）`);
    return [];
  }
}

// ================================================================
// 爬虫核心：使用 Vue pageChange 翻页并提取全部数据
// ================================================================

async function scrapeAllPages(page, targetDate) {
  // 等待表格渲染
  try {
    await page.waitForSelector('.qccd-table-tbody tr', { timeout: 10000 });
  } catch {
    console.log('[提取] 表格未出现，可能无数据');
    return { allData: [], pageInfo: [] };
  }

  // 单一 evaluate 调用：在浏览器内完成全部翻页+提取
  let result;
  for (let retry = 0; retry < 3; retry++) {
    try {
      result = await page.evaluate(({ targetDate, maxPages, delay }) => {
    const listDiv = document.querySelector('.new-company-list');
    const listVm = listDiv && listDiv.__vue__;
    if (!listVm) return JSON.stringify({ error: '找不到列表 Vue 实例' });

    const pagination = document.querySelector('.pagination');
    const pagVm = pagination && pagination.__vue__;
    const totalItems = pagVm ? pagVm.total : 0;
    const totalPages = Math.min(Math.ceil(totalItems / 20), maxPages);

    const allData = [];
    const pageInfo = [];

    // 使用 async IIFE 包装（evaluate 支持 async）
    return (async () => {
      for (let page = 1; page <= totalPages; page++) {
        // 翻页
        listVm.pageChange(page);
        await new Promise(r => setTimeout(r, delay));

        // 提取当前页数据
        const rows = document.querySelectorAll('.qccd-table-tbody tr');
        const companies = [];
        for (let i = 0; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll('td');
          if (cells.length >= 7) {
            companies.push({
              name: cells[1].textContent.trim(),
              status: cells[2].textContent.trim(),
              representative: cells[3].textContent.trim(),
              capital: cells[4].textContent.trim(),
              date: cells[5].textContent.trim(),
              creditCode: cells[6].textContent.trim(),
              address: cells[7] ? cells[7].textContent.trim() : '',
            });
          }
        }

        if (companies.length === 0) break;

        const dates = companies.map(c => c.date).sort();
        const oldest = dates[0];
        const newest = dates[dates.length - 1];
        const matched = companies.filter(c => c.date === targetDate);

        allData.push(...matched);
        pageInfo.push({ page, rows: companies.length, matched: matched.length, oldest, newest });

        // 当前页最晚的日期都早于目标日期 → 后续页更早，停止
        if (newest < targetDate) break;
      }

      return JSON.stringify({ allData, pageInfo, totalItems });
    })();
      }, { targetDate, maxPages: CONFIG.maxPages, delay: CONFIG.pageDelay });
      break;
    } catch (e) {
      if (retry < 2) {
        console.log(`[重试] 翻页 evaluate 失败, 等待后重试 (${retry + 1}/2)...`);
        await sleep(3000);
      } else {
        throw e;
      }
    }
  }

  return JSON.parse(result);
}

// ================================================================
// 主流程
// ================================================================

async function scrapeToday(options = {}) {
  const province = options.province || CONFIG.province;
  const city = options.city || CONFIG.city;
  const headless = options.headless !== undefined ? options.headless : CONFIG.headless;
  const targetDate = options.date || new Date().toISOString().slice(0, 10);

  console.log(`[启动] 目标: ${targetDate} | ${province}/${city} | 无头: ${headless !== false}`);

  const browser = await puppeteer.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--window-size=1280,800',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1280, height: 800 });

  // 隐藏自动化痕迹
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  });

  try {
    // 1. 访问首页获取新鲜 acw_tc
    await page.goto(`${CONFIG.baseUrl}/`, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
    await sleep(1500);

    // 2. 注入登录 cookie（跳过 acw_tc）
    const savedCookies = loadCookies();
    if (savedCookies.length > 0) {
      const loginCookies = savedCookies.filter(c => c.name !== 'acw_tc');
      if (loginCookies.length > 0) {
        await page.setCookie(...loginCookies);
      }
    }

    // 3. 打开筛选页面
    const filterObj = { r: [{ pr: province, cc: city }] };
    const filterStr = JSON.stringify(filterObj);
    const url = `${CONFIG.baseUrl}/web/elib/ncompanylist?filter=${encodeURIComponent(filterStr)}`;

    console.log(`[导航] 列表页: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });

    // 等待页面稳定（WAF 可能在 networkidle2 后再做一次重定向）
    await sleep(2000);
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
      console.log('[导航] 检测到重定向后等待完成');
    } catch {
      // 没有重定向就继续
    }

    // 等待表格或登录框出现
    try {
      await page.waitForSelector('.qccd-table-tbody tr, .login-box, .err-page', { timeout: 15000 });
    } catch {
      console.log('[导航] 等待超时，当前 URL:', page.url());
    }
    await sleep(1000);

    // 4. 检查登录（带重试，防止 evaluate 时页面导航）
    let loginCheck;
    for (let retry = 0; retry < 3; retry++) {
      try {
        loginCheck = await page.evaluate(() => {
          const rows = document.querySelectorAll('.qccd-table-tbody tr');
          if (rows.length > 0) return { ok: true, rows: rows.length };
          const bodyText = document.body?.innerText || '';
          if (bodyText.includes('登录')) return { ok: false, reason: 'not-logged-in' };
          return { ok: false, reason: 'no-data' };
        });
        break;
      } catch (e) {
        if (retry < 2) {
          console.log(`[重试] evaluate 失败, 等待后重试 (${retry + 1}/2)...`);
          await sleep(3000);
        } else {
          throw e;
        }
      }
    }

    if (!loginCheck.ok) {
      if (loginCheck.reason === 'not-logged-in') {
        if (headless !== false) {
          console.error('[错误] 未登录！请在本地运行: node qcc_server.js --login');
          return [];
        }
        console.log('[登录] 请在浏览器中手动登录，完成后按 Enter...');
        await waitForUserInput();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
        await sleep(3000);
      } else {
        console.error('[错误] 页面无数据');
        return [];
      }
    }

    // 检查是否被 WAF 拦截
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('deny')) {
      console.error(`[错误] 页面被拦截: ${currentUrl}`);
      return [];
    }

    // 5. 保存 cookie 快照
    saveCookies(await page.cookies());

    // 6. 翻页提取
    console.log('[提取] 开始翻页提取...');
    const result = await scrapeAllPages(page, targetDate);

    if (result.error) {
      console.error(`[错误] ${result.error}`);
      return [];
    }

    const companies = result.allData || [];
    console.log(`[分页] 共 ${result.pageInfo.length} 页, 匹配 ${targetDate}: ${companies.length} 条`);

    // 7. 保存
    const outputPath = path.join(CONFIG.outputDir, `new_companies_${targetDate}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(companies, null, 2), 'utf-8');

    // 日期分布
    const dateDist = {};
    (result.allData || []).forEach(c => { dateDist[c.date] = (dateDist[c.date] || 0) + 1; });
    if (Object.keys(dateDist).length > 0) {
      console.log(`[日期分布] ${JSON.stringify(dateDist)}`);
    }

    console.log(`[保存] ${outputPath}`);

    if (companies.length > 0) {
      console.log(`\n前 5 条:`);
      companies.slice(0, 5).forEach((c, i) => {
        console.log(`  ${i + 1}. ${c.name} | ${c.capital} | ${c.representative}`);
      });
    } else {
      console.log('[结果] 当日无新增企业（可能是周末或节假日）');
    }

    return companies;

  } finally {
    await browser.close();
  }
}

// ================================================================
// 登录模式
// ================================================================

async function loginMode() {
  console.log('[登录] 打开浏览器，请在页面中登录 qcc.com...');

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${CONFIG.baseUrl}/`, { waitUntil: 'networkidle2' });

  console.log('[登录] 请完成登录（扫码/手机号均可），登录后 cookie 自动保存...');

  const checkInterval = setInterval(async () => {
    try {
      const cookies = await page.cookies();
      if (cookies.some(c => c.name === 'QCCSESSID')) {
        saveCookies(cookies);
        console.log('[登录] 完成！qcc_cookies.json 已保存');
        clearInterval(checkInterval);
        await browser.close();
        process.exit(0);
      }
    } catch {}
  }, 5000);

  await new Promise(() => {});
}

// ================================================================
// CLI
// ================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--login':    opts.login = true; break;
      case '--province': opts.province = args[++i]; break;
      case '--city':     opts.city = args[++i]; break;
      case '--date':     opts.date = args[++i]; break;
      case '--headless': opts.headless = args[++i] !== 'false'; break;
      case '--output':   CONFIG.outputDir = args[++i]; break;
      case '--help':
        console.log(`
企查查每日新增企业爬虫（服务器版）

用法: node qcc_server.js [选项]

选项:
  --login              打开浏览器手动登录，保存 cookies
  --province <code>    省份代码 (默认: BJ)
  --city <code>        城市区号 (默认: 110101)
  --date <YYYY-MM-DD>  目标日期 (默认: 今天)
  --output <dir>       输出目录
  --headless <bool>    无头模式 (默认: true)

首次: node qcc_server.js --login
日常: node qcc_server.js
`);
        process.exit(0);
    }
  }
  return opts;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForUserInput() {
  return new Promise(resolve => {
    process.stdin.once('data', () => resolve());
  });
}

// ================================================================
(async () => {
  const opts = parseArgs();
  if (opts.login) {
    await loginMode();
  } else {
    const count = await scrapeToday(opts);
    console.log(`\n[完成] 共 ${count.length} 条`);
  }
})();
