#!/usr/bin/env python3
"""
企查查 - 当日新增企业信息爬虫

★ 桌面端：opencli qccspider today（需要 opencli 和 Chrome 登录）
★ 服务器端：node qcc_server.js（使用 Puppeteer 无头浏览器）
★ 浏览器端：Chrome Console 中运行 qcc_spider.js
★ 本脚本（requests）：因 WAF TLS 绑定，仅作参考，实际可用性有限
"""

import hashlib
import json
import os
import re
import time
from datetime import datetime, timedelta
from typing import Optional

import browser_cookie3
import requests


# ================================================================
# Cookie
# ================================================================

def get_chrome_cookies(domain: str = "qcc.com") -> dict:
    """从 Chrome 本地存储读取 cookies"""
    try:
        return {c.name: c.value for c in browser_cookie3.chrome(domain_name=domain)}
    except Exception:
        return {}


def load_login_cookies() -> dict:
    """按优先级加载登录 cookies"""
    # 1. Chrome
    cookies = get_chrome_cookies()
    if cookies.get("QCCSESSID"):
        print(f"[Cookie] Chrome (QCCSESSID={cookies['QCCSESSID'][:20]}...)")
        return cookies

    # 2. 环境变量
    env = os.environ.get("QCC_COOKIE")
    if env:
        print("[Cookie] 环境变量 QCC_COOKIE")
        return dict(item.split("=", 1) for item in env.split("; ") if "=" in item)

    # 3. cookie.txt
    path = os.path.join(os.path.dirname(__file__), "cookie.txt")
    if os.path.exists(path):
        with open(path) as f:
            content = f.read().strip()
        print("[Cookie] cookie.txt")
        return dict(item.split("=", 1) for item in content.split("; ") if "=" in item)

    print("[Cookie] 未找到登录 cookie")
    return {}


# ================================================================
# 爬虫
# ================================================================

class QccSpider:
    BASE_URL = "https://www.qcc.com"

    def __init__(self):
        self.session = requests.Session()
        self._login_cookies = load_login_cookies()

    @staticmethod
    def _browser_headers(dest: str, mode: str, site: str) -> dict:
        return {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-encoding": "gzip, deflate, br",
            "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
            "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"macOS"',
            "sec-fetch-dest": dest,
            "sec-fetch-mode": mode,
            "sec-fetch-site": site,
            "user-agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/148.0.0.0 Safari/537.36"
            ),
        }

    def init_session(self) -> bool:
        """获取 WAF cookie 并注入登录 cookie"""
        h = self._browser_headers("document", "navigate", "none")

        resp = self.session.get(self.BASE_URL + "/", headers=h, timeout=30)
        print(f"[WAF] 首页 HTTP {resp.status_code}")
        if resp.status_code != 200:
            return False

        h["sec-fetch-site"] = "same-origin"
        resp = self.session.get(
            f"{self.BASE_URL}/web/elib/ncompanylist", headers=h, timeout=30
        )
        print(f"[WAF] 列表页 HTTP {resp.status_code}")

        for key, value in self._login_cookies.items():
            if key != "acw_tc":
                self.session.cookies.set(key, value, domain=".qcc.com")

        has_login = bool(self._login_cookies.get("QCCSESSID"))
        print(f"[Auth] {'已注入登录 cookie' if has_login else '未登录'}")
        return has_login

    def fetch_page(
        self,
        province: str,
        city_code: Optional[str],
        page_index: int,
        page_size: int = 20,
    ) -> Optional[dict]:
        r_list = [{"pr": province}]
        if city_code:
            r_list[0]["cc"] = city_code
        filter_obj = {"r": r_list}
        filter_str = json.dumps(filter_obj, separators=(",", ":"))
        referer = f"{self.BASE_URL}/web/elib/ncompanylist?filter={filter_str}"

        h = self._browser_headers("empty", "cors", "same-origin")
        h.update({
            "accept": "application/json, text/plain, */*",
            "content-type": "application/json",
            "origin": self.BASE_URL,
            "referer": referer,
            "x-pid": hashlib.md5(str(time.time()).encode()).hexdigest(),
            "x-requested-with": "XMLHttpRequest",
        })

        resp = self.session.post(
            f"{self.BASE_URL}/api/elib/postNewCompany",
            headers=h,
            json={"filter": filter_obj, "pageIndex": page_index, "pageSize": page_size},
            timeout=30,
        )
        data = resp.json()
        code = data.get("status")

        if code == 200:
            return data
        if code == 409:
            raise RuntimeError("未登录！请在 Chrome 中登录 qcc.com 后重试。")
        if code == 435:
            raise RuntimeError(
                "Cookie 无效。WAF 的 acw_tc 绑定 TLS 会话，"
                "Python requests 的 TLS 指纹与浏览器不同，导致被拦截。\n"
                "→ 请使用方法: 在 Chrome Console 中运行 qcc_spider.js"
            )
        return None

    def fetch_yesterday(
        self,
        province: str = "BJ",
        city_code: Optional[str] = None,
        page_size: int = 20,
        max_pages: int = 50,
        delay: float = 1.0,
    ) -> list:
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        all_companies = []

        print(f"\n目标: {yesterday} | {province} | {city_code or '全省'}")
        print("-" * 50)

        for page in range(1, max_pages + 1):
            print(f"第 {page:>2} 页", end=" ", flush=True)
            data = self.fetch_page(province, city_code, page, page_size)

            if data is None:
                print("— 失败")
                break

            companies = self._extract(data)
            if not companies:
                print("— 无数据")
                break

            matched = [
                c for c in companies
                if c.get("StartDate") == yesterday
                or c.get("registDate") == yesterday
            ]
            all_companies.extend(matched)
            print(f"— {len(matched)} 条 (累计 {len(all_companies)})")

            if len(matched) < len(companies):
                break
            time.sleep(delay)

        return all_companies

    @staticmethod
    def _extract(data: dict) -> list:
        for key in ("data", "list", "result", "records", "items"):
            if isinstance(data.get(key), list):
                return data[key]
        for outer in ("data", "result"):
            inner = data.get(outer)
            if isinstance(inner, dict):
                for key in ("list", "records", "items", "Result", "data"):
                    if isinstance(inner.get(key), list):
                        return inner[key]
        return []

    def save_json(self, companies: list, filename: Optional[str] = None):
        if not filename:
            filename = f"new_companies_{datetime.now().strftime('%Y%m%d')}.json"
        path = os.path.join(os.path.dirname(__file__), filename)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(companies, f, ensure_ascii=False, indent=2)
        print(f"\n已保存 {len(companies)} 条 → {path}")


# ================================================================
def main():
    PROVINCE = "BJ"
    CITY_CODE = "110101"
    PAGE_SIZE = 20
    MAX_PAGES = 50
    DELAY = 1.0

    spider = QccSpider()

    try:
        spider.init_session()
    except RuntimeError as e:
        print(f"\n{e}")
        return

    companies = spider.fetch_yesterday(
        province=PROVINCE,
        city_code=CITY_CODE,
        page_size=PAGE_SIZE,
        max_pages=MAX_PAGES,
        delay=DELAY,
    )

    print("-" * 50)
    print(f"共 {len(companies)} 条")

    if companies:
        spider.save_json(companies)
        for i, c in enumerate(companies[:10], 1):
            name = c.get("CompanyName") or c.get("companyName") or "N/A"
            print(f"  {i}. {name}")
    else:
        print("\n无数据。请确认已登录且昨日有新增企业。")


if __name__ == "__main__":
    main()
