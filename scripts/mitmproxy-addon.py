"""
mitmproxy addon - HTTPS 请求拦截转发至网关
===========================================

用法:
  mitmproxy -s scripts/mitmproxy-addon.py --listen-port 8080

工作原理:
  1. 拦截匹配 INTERCEPT_DOMAINS 的 HTTPS 请求
  2. 将请求重写到你的网关地址 (GATEWAY_URL)
  3. 注入网关 token 替换原始 Authorization
  4. 其他流量原样放行

配置方式 (环境变量):
  GATEWAY_URL          - 网关地址，如 http://1.2.3.4:18790 或 https://your-domain.com
  GATEWAY_TOKEN        - 网关 token，如 sk-deploy-001
  INTERCEPT_DOMAINS    - 逗号分隔的拦截域名列表
  INTERCEPT_PATH_PREFIX - 拦截的路径前缀，默认 /v1/chat/completions
"""

import os
import json
from mitmproxy import http, ctx

# ---- 配置 ----
GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://127.0.0.1:18790")
GATEWAY_TOKEN = os.environ.get("GATEWAY_TOKEN", "sk-deploy-001")
# 默认拦截 Codeium/Windsurf 相关域名（可通过环境变量覆盖）
_DEFAULT_DOMAINS = "api.codeium.com,server.codeium.com,web-backend.codeium.com"
INTERCEPT_DOMAINS = [
    d.strip()
    for d in os.environ.get("INTERCEPT_DOMAINS", _DEFAULT_DOMAINS).split(",")
    if d.strip()
]
INTERCEPT_PATH_PREFIX = os.environ.get("INTERCEPT_PATH_PREFIX", "")  # 空=拦截所有路径

# 解析网关 URL
from urllib.parse import urlparse

_parsed = urlparse(GATEWAY_URL)
GATEWAY_HOST = _parsed.hostname or "127.0.0.1"
GATEWAY_PORT = _parsed.port or (443 if _parsed.scheme == "https" else 80)
GATEWAY_SCHEME = _parsed.scheme or "http"


class GatewayInterceptor:
    def load(self, loader):
        ctx.log.info(f"[gateway-addon] gateway url: {GATEWAY_URL}")
        ctx.log.info(f"[gateway-addon] intercept domains: {INTERCEPT_DOMAINS}")
        ctx.log.info(f"[gateway-addon] intercept path prefix: {INTERCEPT_PATH_PREFIX}")
        if not INTERCEPT_DOMAINS:
            ctx.log.warn(
                "[gateway-addon] WARNING: INTERCEPT_DOMAINS is empty! "
                "Set env var INTERCEPT_DOMAINS=api.example.com,other.example.com"
            )

    def request(self, flow: http.HTTPFlow) -> None:
        host = flow.request.pretty_host
        path = flow.request.path

        # 仅拦截匹配域名和路径的请求
        if not self._should_intercept(host, path):
            return

        original_host = host
        original_url = flow.request.pretty_url

        # 重写目标到网关
        flow.request.scheme = GATEWAY_SCHEME
        flow.request.host = GATEWAY_HOST
        flow.request.port = GATEWAY_PORT

        # 注入网关 token
        flow.request.headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

        # 保留原始请求信息用于日志
        flow.request.headers["X-Original-Host"] = original_host
        flow.request.headers["X-Intercepted-By"] = "cyber-drill-gateway"

        ctx.log.info(
            f"[gateway-addon] intercepted: {original_url} -> "
            f"{GATEWAY_SCHEME}://{GATEWAY_HOST}:{GATEWAY_PORT}{path}"
        )

    def response(self, flow: http.HTTPFlow) -> None:
        # 记录被拦截请求的响应状态
        if flow.request.headers.get("X-Intercepted-By") == "cyber-drill-gateway":
            original_host = flow.request.headers.get("X-Original-Host", "unknown")
            ctx.log.info(
                f"[gateway-addon] response: {original_host}{flow.request.path} "
                f"-> status={flow.response.status_code}"
            )

            # 清理注入的 header，避免暴露
            del flow.request.headers["X-Intercepted-By"]
            if "X-Original-Host" in flow.request.headers:
                del flow.request.headers["X-Original-Host"]

    def _should_intercept(self, host: str, path: str) -> bool:
        if not INTERCEPT_DOMAINS:
            return False

        domain_match = any(
            host == domain or host.endswith(f".{domain}")
            for domain in INTERCEPT_DOMAINS
        )

        if not domain_match:
            return False

        if INTERCEPT_PATH_PREFIX and not path.startswith(INTERCEPT_PATH_PREFIX):
            return False

        return True


addons = [GatewayInterceptor()]
