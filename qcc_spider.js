/**
 * 企查查 - 当日新增企业抓取（浏览器 Console 版）
 *
 * 使用方法：
 *   1. 在 Chrome 中打开 www.qcc.com 并登录
 *   2. 按 F12 打开 DevTools → Console
 *   3. 粘贴以下全部代码，按 Enter 运行
 *   4. 数据将自动下载为 JSON 文件
 *
 * 纯 JS 实现，复用浏览器登录态 + WAF token，零依赖。
 */

(async () => {
  // ==================== 配置 ====================
  const PROVINCE = "BJ";        // 省份代码
  const CITY_CODE = "110101";   // 城市区号，null=全省
  const PAGE_SIZE = 20;
  const MAX_PAGES = 50;
  const DELAY = 800;            // 请求间隔（ms）
  // ==============================================

  // 计算 T-1 日期
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const TARGET_DATE = yesterday.toISOString().slice(0, 10);

  const allData = [];
  const filter = { r: [{ pr: PROVINCE }] };
  if (CITY_CODE) filter.r[0].cc = CITY_CODE;

  console.log(`目标日期: ${TARGET_DATE} | 省份: ${PROVINCE} | 区号: ${CITY_CODE || "全省"}`);
  console.log("-".repeat(50));

  for (let page = 1; page <= MAX_PAGES; page++) {
    const xhr = new XMLHttpRequest();
    const body = JSON.stringify({ filter, pageIndex: page, pageSize: PAGE_SIZE });

    const resp = await new Promise((resolve) => {
      xhr.open("POST", "/api/elib/postNewCompany");
      xhr.setRequestHeader("accept", "application/json, text/plain, */*");
      xhr.setRequestHeader("content-type", "application/json");
      xhr.setRequestHeader("x-requested-with", "XMLHttpRequest");
      xhr.onload = () => {
        try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(null); }
      };
      xhr.onerror = () => resolve(null);
      xhr.send(body);
    });

    if (!resp || resp.status !== 200) {
      console.error(`第 ${page} 页失败:`, resp?.message || resp?.status);
      break;
    }

    // 适配多种可能的响应结构
    let companies = resp.data || resp.list || resp.result?.Result || resp.result?.data || [];
    if (!Array.isArray(companies)) companies = [];

    if (!companies.length) {
      console.log(`第 ${page} 页: 无数据，结束`);
      break;
    }

    const matched = companies.filter(c =>
      c.StartDate === TARGET_DATE ||
      c.registDate === TARGET_DATE ||
      c.estDate === TARGET_DATE
    );

    allData.push(...matched);
    console.log(`第 ${page} 页: ${matched.length} 条匹配 (累计 ${allData.length})`);

    if (matched.length < companies.length) break;
    await new Promise(r => setTimeout(r, DELAY));
  }

  console.log("-".repeat(50));
  console.log(`共 ${allData.length} 条 T-1 新增企业`);

  // 自动下载 JSON
  if (allData.length > 0) {
    const blob = new Blob([JSON.stringify(allData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `new_companies_${TARGET_DATE}.json`;
    a.click();
    URL.revokeObjectURL(url);
    console.log(`已下载 new_companies_${TARGET_DATE}.json`);

    // 同时打印到 console 方便查看
    console.log("\n前 10 条预览:");
    allData.slice(0, 10).forEach((c, i) => {
      const name = c.CompanyName || c.companyName || c.name || "N/A";
      const date = c.StartDate || c.registDate || c.estDate || "";
      const capital = c.RegistCapi || c.regCapital || c.regCap || "";
      console.log(`  ${i + 1}. ${name} | ${capital} | ${date}`);
    });
  } else {
    console.log("⚠ 未获取到数据。请确认：");
    console.log("  1. 已在 qcc.com 登录");
    console.log("  2. 省份代码和城市区号正确");
    console.log("  3. 昨日有新增企业");
  }
})();
