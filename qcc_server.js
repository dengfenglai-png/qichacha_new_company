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

// ================================================================
// 工具函数
// ================================================================

/** 生成 [min, max] 范围内的随机整数 */
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 随机延迟：基准值 ± 浮动比例，最小不低于 minMs */
function randomDelay(baseMs, variance = 0.4, minMs = 500) {
  const ms = Math.max(minMs, baseMs + randomBetween(-Math.floor(baseMs * variance), Math.floor(baseMs * variance)));
  return new Promise(r => setTimeout(r, ms));
}

/** 模拟人类滚动：随机滚动几次 */
async function humanScroll(page) {
  for (let i = 0; i < randomBetween(1, 3); i++) {
    await page.evaluate((dist) => {
      window.scrollBy({ top: dist, behavior: 'smooth' });
    }, randomBetween(100, 500));
    await randomDelay(400, 0.5, 200);
  }
}

/** 模拟鼠标随机移动 */
async function humanMouseMove(page) {
  const x = randomBetween(100, 900);
  const y = randomBetween(100, 600);
  await page.mouse.move(x, y, { steps: randomBetween(3, 10) });
}

/** 随机 User-Agent 池 */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const CONFIG = {
  baseUrl: 'https://www.qcc.com',
  cookieFile: path.join(__dirname, 'qcc_cookies.json'),
  outputDir: __dirname,
  province: 'BJ',
  city: '110101',
  date: null,
  headless: 'new',
  timeout: 30000,
  maxPages: 30,            // 从 60 降到 30，减少单次爬取量
  pageDelayMin: 1800,      // 翻页最小延迟（ms）
  pageDelayMax: 3500,      // 翻页最大延迟（ms）
  proxy: null,             // 代理地址，如 http://user:pass@ip:port
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

  // 先模拟一波人类行为再开始提取
  await humanScroll(page);
  await humanMouseMove(page);
  await randomDelay(800, 0.5, 400);

  // 单一 evaluate 调用：在浏览器内完成全部翻页+提取
  // 每次翻页间使用随机延迟，模拟人类点击翻页的节奏
  let result;
  for (let retry = 0; retry < 3; retry++) {
    try {
      result = await page.evaluate(({ targetDate, maxPages, delayMin, delayMax }) => {
    const listDiv = document.querySelector('.new-company-list');
    const listVm = listDiv && listDiv.__vue__;
    if (!listVm) return JSON.stringify({ error: '找不到列表 Vue 实例' });

    const pagination = document.querySelector('.pagination');
    const pagVm = pagination && pagination.__vue__;
    const totalItems = pagVm ? pagVm.total : 0;
    const totalPages = Math.min(Math.ceil(totalItems / 20), maxPages);

    const allData = [];
    const pageInfo = [];

    function randomDelayInPage(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    return (async () => {
      for (let p = 1; p <= totalPages; p++) {
        // 随机延迟后再翻页（模拟人看一页数据的时间）
        const delay = randomDelayInPage(delayMin, delayMax);
        listVm.pageChange(p);
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
        pageInfo.push({ page: p, rows: companies.length, matched: matched.length, oldest, newest });

        // 当前页最晚的日期都早于目标日期 → 后续页更早，停止
        if (newest < targetDate) break;

        // 每隔几页额外休息一次（模拟人中途停顿）
        if (p % randomDelayInPage(3, 7) === 0) {
          await new Promise(r => setTimeout(r, randomDelayInPage(2000, 5000)));
        }
      }

      return JSON.stringify({ allData, pageInfo, totalItems });
    })();
      }, { targetDate, maxPages: CONFIG.maxPages, delayMin: CONFIG.pageDelayMin, delayMax: CONFIG.pageDelayMax });
      break;
    } catch (e) {
      if (retry < 2) {
        const wait = randomBetween(3000, 6000);
        console.log(`[重试] 翻页 evaluate 失败, 等待 ${wait}ms 后重试 (${retry + 1}/2)...`);
        await sleep(wait);
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

  // 代理配置：CLI 参数 > 环境变量 QCC_PROXY > CONFIG
  const proxy = options.proxy || process.env.QCC_PROXY || CONFIG.proxy;
  if (proxy) {
    console.log(`[代理] 使用代理: ${proxy.replace(/\/\/.*@/, '//***@')}`);  // 隐藏密码
  }

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-infobars',
    `--window-size=${randomBetween(1200, 1400)},${randomBetween(750, 900)}`,
    '--disable-dev-shm-usage',
  ];

  if (proxy) {
    launchArgs.push(`--proxy-server=${proxy}`);
  }

  const browser = await puppeteer.launch({
    headless,
    args: launchArgs,
  });

  const page = await browser.newPage();

  // 代理认证（如果代理 URL 包含用户名密码）
  if (proxy) {
    try {
      const proxyUrl = new URL(proxy);
      if (proxyUrl.username && proxyUrl.password) {
        await page.authenticate({
          username: decodeURIComponent(proxyUrl.username),
          password: decodeURIComponent(proxyUrl.password),
        });
      }
    } catch {}
  }

  // 随机 User-Agent
  const ua = randomUA();
  await page.setUserAgent(ua);
  console.log(`[UA] ${ua.slice(0, 60)}...`);

  // 随机化视口尺寸（模拟真实屏幕差异）
  const vw = randomBetween(1200, 1400);
  const vh = randomBetween(750, 900);
  await page.setViewport({ width: vw, height: vh });

  // 设置语言相关的 HTTP 头
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
  });

  // 隐藏自动化痕迹（增强版）
  await page.evaluateOnNewDocument(() => {
    // 隐藏 webdriver 标记
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // 伪造 plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [1, 2, 3, 4, 5];
        plugins.item = () => null;
        plugins.namedItem = () => null;
        plugins.refresh = () => {};
        return plugins;
      }
    });

    // 伪造 languages
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' });

    // 伪造 platform
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

    // 伪造 hardwareConcurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

    // 伪造 deviceMemory
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    // 伪造 chrome 对象
    window.chrome = {
      runtime: {},
      loadTimes: () => {},
      csi: () => {},
      app: {},
    };

    // 伪造 permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
  });

  try {
    // 1. 访问首页获取新鲜 acw_tc（带随机延迟模拟人类打开浏览器）
    console.log('[导航] 访问首页...');
    await page.goto(`${CONFIG.baseUrl}/`, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
    await humanScroll(page);
    await humanMouseMove(page);
    await randomDelay(2000, 0.3, 1500);

    // 2. 注入登录 cookie（跳过 acw_tc）
    const savedCookies = loadCookies();
    if (savedCookies.length > 0) {
      const loginCookies = savedCookies.filter(c => c.name !== 'acw_tc');
      if (loginCookies.length > 0) {
        await page.setCookie(...loginCookies);
        console.log(`[Cookie] 注入 ${loginCookies.length} 个登录 cookie`);
      }
    } else {
      console.error('[Cookie] 无可用的登录 cookie，将尝试未登录访问');
    }

    // 3. 打开筛选页面
    const filterObj = { r: [{ pr: province, cc: city }] };
    const filterStr = JSON.stringify(filterObj);
    const url = `${CONFIG.baseUrl}/web/elib/ncompanylist?filter=${encodeURIComponent(filterStr)}`;

    console.log(`[导航] 列表页: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
    // 页面加载后模拟人类浏览行为
    await humanScroll(page);
    await humanMouseMove(page);
    await randomDelay(3000, 0.35, 2000);

    // 等表格出现（WAF 可能在加载后做重定向）
    try {
      await page.waitForSelector('.qccd-table-tbody tr, .login-box, .err-page', { timeout: 10000 });
    } catch {
      console.log('[导航] 表格未出现，当前 URL:', page.url());
    }

    // 4. 检查登录（带重试，防止 evaluate 时页面导航）
    let loginCheck;
    for (let retry = 0; retry < 3; retry++) {
      try {
        loginCheck = await page.evaluate(() => {
          const rows = document.querySelectorAll('.qccd-table-tbody tr');
          if (rows.length > 0) return { ok: true, rows: rows.length };
          const bodyText = document.body?.innerText || '';
          const title = document.title || '';
          // 截取前 500 字符用于调试
          const preview = bodyText.slice(0, 500);
          if (bodyText.includes('登录')) return { ok: false, reason: 'not-logged-in', title, preview };
          if (bodyText.includes('验证') || bodyText.includes('安全')) return { ok: false, reason: 'challenge', title, preview };
          return { ok: false, reason: 'no-data', title, preview };
        });
        break;
      } catch (e) {
        if (retry < 2) {
          const wait = randomBetween(3000, 6000);
          console.log(`[重试] evaluate 失败, 等待 ${wait}ms 后重试 (${retry + 1}/2)...`);
          await sleep(wait);
        } else {
          throw e;
        }
      }
    }

    if (!loginCheck.ok) {
      if (loginCheck.reason === 'not-logged-in') {
        console.error(`[错误] 未登录 | title: ${loginCheck.title} | 请更新 QCC_COOKIE secret`);
        if (headless !== false) {
          return [];
        }
        console.log('[登录] 请在浏览器中手动登录，完成后按 Enter...');
        await waitForUserInput();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
        await randomDelay(3000, 0.3, 2000);
      } else if (loginCheck.reason === 'challenge') {
        console.error(`[错误] 遇到验证页面 | title: ${loginCheck.title} | body: ${loginCheck.preview?.slice(0, 200)}`);
        return [];
      } else {
        console.error(`[错误] 页面无数据 | title: ${loginCheck.title} | body: ${loginCheck.preview?.slice(0, 200)}`);
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

    // 7. 保存（空数据不写文件，避免无意义的 commit）
    if (companies.length > 0) {
      const outputPath = path.join(CONFIG.outputDir, `new_companies_${targetDate}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(companies, null, 2), 'utf-8');

      // 日期分布
      const dateDist = {};
      result.allData.forEach(c => { dateDist[c.date] = (dateDist[c.date] || 0) + 1; });
      console.log(`[日期分布] ${JSON.stringify(dateDist)}`);
      console.log(`[保存] ${outputPath}`);

      console.log(`\n前 5 条:`);
      companies.slice(0, 5).forEach((c, i) => {
        console.log(`  ${i + 1}. ${c.name} | ${c.capital} | ${c.representative}`);
      });
    } else {
      console.log('[结果] 当日无新增企业（可能是周末或节假日），跳过保存');
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
      case '--proxy':    opts.proxy = args[++i]; break;
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
  --proxy <url>        代理地址 (如 http://user:pass@ip:port)
  --headless <bool>    无头模式 (默认: true)

首次: node qcc_server.js --login
日常: node qcc_server.js
GHA: node qcc_server.js --proxy "$QCC_PROXY"
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
    // 启动时随机延迟 0-5 分钟（避免定时任务整点触发，降低被检测风险）
    const startupJitter = randomBetween(0, 300000);
    console.log(`[启动] 随机延迟 ${(startupJitter / 1000).toFixed(0)}s 后开始爬取...`);
    await sleep(startupJitter);

    const count = await scrapeToday(opts);
    console.log(`\n[完成] 共 ${count.length} 条`);
  }
})();
