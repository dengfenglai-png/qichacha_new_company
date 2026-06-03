#!/bin/bash
# 导出企查查 Chrome cookies 为 QCC_COOKIE 环境变量格式
# 用法: bash export_cookies.sh
# 输出可直接粘贴到 GitHub Secrets → QCC_COOKIE

echo "正在从 Chrome 读取 cookies..."

python3 -c "
import browser_cookie3
cookies = browser_cookie3.chrome(domain_name='qcc.com')
cookie_str = '; '.join(f'{c.name}={c.value}' for c in cookies)
print()
print('=== 复制下面这行到 GitHub Secrets (QCC_COOKIE) ===')
print(cookie_str)
print()
print(f'共导出 {len(cookies)} 个 cookies')
" 2>/dev/null || {
  echo "错误: 需要安装 browser_cookie3"
  echo "  pip install browser-cookie3"
}
