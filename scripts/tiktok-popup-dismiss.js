/*
 * Seller Center occasionally opens campaign, announcement, or onboarding
 * overlays after navigation.  They are not part of the login flow, but they
 * intercept clicks and therefore must be cleared before an automation step.
 */
async function clickFirstVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!await item.isVisible().catch(() => false)) continue;
    await item.click({ force: true, timeout: 3000 }).catch(() => {});
    return true;
  }
  return false;
}

async function dismissSellerPopups(page) {
  // Never treat a TikTok login / CAPTCHA challenge as a disposable campaign
  // overlay.  Both use an “X” button, and the old generic close selector
  // could dismiss the challenge immediately after it appeared.
  const visibleText = await page.locator('body').innerText().catch(() => '');
  if (/点击选中两个相同形状的物体|验证码|安全验证|二次验证|两步验证|身份验证|security verification|captcha|challenge|report a problem/i.test(visibleText)) return false;
  // Run several short passes because dismissing one announcement may reveal
  // another one.  Do not fail a sync when there is simply no overlay.
  for (let pass = 0; pass < 3; pass += 1) {
    let dismissed = false;
    for (const label of ['我知道了', '知道了', '稍后再说', '暂不处理']) {
      dismissed = await clickFirstVisible(page.getByRole('button', { name: label, exact: true }));
      if (!dismissed) dismissed = await clickFirstVisible(page.getByText(label, { exact: true }));
      if (dismissed) break;
    }
    if (!dismissed) {
      dismissed = await clickFirstVisible(page.locator('[aria-label="关闭"], [aria-label="Close"], [title="关闭"], [title="Close"]'));
    }
    if (!dismissed) break;
    await page.waitForTimeout(350);
  }
}

async function settleSellerPopups(page, durationMs = 4000) {
  // Campaign overlays often mount a moment after `domcontentloaded`. Keep
  // watching briefly on first navigation so an overlay cannot appear between
  // the initial check and the first task click.
  const until = Date.now() + durationMs;
  do {
    await dismissSellerPopups(page);
    if (Date.now() >= until) break;
    await page.waitForTimeout(300);
  } while (Date.now() < until);
}

module.exports = { dismissSellerPopups, settleSellerPopups };
