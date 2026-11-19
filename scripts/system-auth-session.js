/* Shared, local-only system authorisation for Sync Assistant jobs. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptDirectory = __dirname;
const vaultExecutable = path.join(scriptDirectory, 'SystemAuthVault.exe');
const captureScript = path.join(scriptDirectory, 'capture-system-auth.js');

function readSession(rootDir) {
  const result = spawnSync(vaultExecutable, ['read', rootDir], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !String(result.stdout || '').trim()) {
    throw new Error('尚未完成系统管理员授权。请在同步助手中点击“系统授权登录”后重试。');
  }
  try { return JSON.parse(Buffer.from(String(result.stdout).trim(), 'base64').toString('utf8')); }
  catch (_) { throw new Error('本机系统管理员授权无法读取，请重新授权。'); }
}

function saveSession(rootDir, session) {
  const result = spawnSync(vaultExecutable, ['save', rootDir], {
    encoding: 'utf8', windowsHide: true, input: Buffer.from(JSON.stringify(session), 'utf8').toString('base64')
  });
  if (result.status !== 0) throw new Error('无法更新本机系统管理员授权，请重新授权。');
}

function urlFor(config) {
  return String(process.env.LOCAL_SYSTEM_URL || config.systemUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
}

async function validate(url, session) {
  return fetch(`${url}/api/auth/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: session.accessToken })
  });
}

async function refresh(url, rootDir, session) {
  const response = await fetch(`${url}/api/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refreshToken })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.session?.accessToken || !payload.session?.refreshToken) return null;
  const renewed = { ...session, ...payload.session, primaryRole: payload.primaryRole, user: payload.user };
  saveSession(rootDir, renewed);
  return renewed;
}

function restoreByPassword(rootDir) {
  const result = spawnSync(process.execPath, [captureScript, '--auto-login'], {
    encoding: 'utf8', windowsHide: true, timeout: 120000
  });
  if (result.status !== 0) {
    throw new Error('系统管理员授权已失效，且 30 天自动登录未能恢复。请在同步助手中点击“系统授权登录”，勾选“记住登录状态、记住密码”后重新授权。');
  }
  return readSession(rootDir);
}

async function resolveSystemSession(config) {
  const rootDir = config.rootDir;
  const url = urlFor(config);
  let session = readSession(rootDir);
  if ((await validate(url, session)).ok) return session;
  const refreshed = await refresh(url, rootDir, session);
  if (refreshed && (await validate(url, refreshed)).ok) return refreshed;
  session = restoreByPassword(rootDir);
  if ((await validate(url, session)).ok) return session;
  const restored = await refresh(url, rootDir, session);
  if (restored && (await validate(url, restored)).ok) return restored;
  throw new Error('自动恢复系统登录后授权校验仍失败，请在同步助手中重新授权。');
}

module.exports = { readSession, saveSession, resolveSystemSession, systemUrl: urlFor };
