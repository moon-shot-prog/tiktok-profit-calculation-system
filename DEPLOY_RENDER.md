# Render 部署说明

## 1. 创建 GitHub 私有仓库

在 GitHub 新建一个私有仓库，例如 `tiktok-profit-calculation-system`。不要上传 `.env` 文件。

在本项目目录运行：

```powershell
git init
git add .
git commit -m "Initial TikTok profit system"
git branch -M main
git remote add origin 你的 GitHub 仓库地址
git push -u origin main
```

## 2. 在 Render 创建服务

1. 登录 Render，点击 **New** → **Blueprint**。
2. 连接 GitHub 并选择刚创建的仓库。
3. Render 会读取 `render.yaml`；确认创建 Web Service。
4. 选择套餐：免费套餐只适合临时演示，可能休眠；团队日常使用请选择常驻付费套餐。
5. 在环境变量页面填写以下三项真实值（从本机 `.env` 复制），不要提交到 GitHub：
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
6. 点击部署，等待状态变为 **Live**。

Render 会提供类似 `https://tiktok-profit-calculation-system.onrender.com` 的 HTTPS 地址。

## 3. 更新 Supabase 跳转地址

在 Supabase：**Authentication** → **URL Configuration**：

- `Site URL`：填写 Render 的 HTTPS 地址。
- `Redirect URLs`：增加 `Render 的 HTTPS 地址/**`。
- 保留 `http://localhost:3000/**`，以便本机继续测试。

## 安全规则

- `.env`、数据库密码和 `SUPABASE_SECRET_KEY` 永远不要上传 GitHub 或发送到聊天。
- `SUPABASE_SECRET_KEY` 只能填写在 Render 的 Environment 页面，不能放到浏览器代码。
