# TikTok 自动下载运行器

该运行器使用独立的本机 Chrome 配置，不读取或改变原有 Chrome 配置，不保存 TikTok 密码，也不向 GitHub、Render 或 Supabase 发送登录信息。

## 首次准备

运行 `npm run tiktok:setup`，在弹出的 Chrome 窗口完成 TikTok Shop Seller Center 登录。登录会话仅保存在 `G:\源文件\自动同步\浏览器配置\TikTokShop下载助手`。

登录完成后，常驻运行器会保持自动化控制通道与该 Chrome 会话一致。它只监听本机地址 `127.0.0.1:3077`，外部网络无法访问。

运行器会先读取当前页面可见的店铺名称与国家站点，用作文件归档和系统店铺配对依据；导出文件本身的同名不会影响识别。

每个已验证的“Seller Center 店铺名称 + 国家站点”与系统店铺的对应关系仅保存于本机 `scripts/tiktok-automation.config.json`，该文件不会提交到 GitHub。

## 安全边界

- 目前阶段只打开登录页面和确认页面可访问。
- 不下载、导入、提交或修改任何业务数据。
- 后续下载流程会先识别当前登录店铺和国家站点，再按日期下载并交由本地同步助手校验。
