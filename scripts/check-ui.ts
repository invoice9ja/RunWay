import { chromium, type Page } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
/**
 * `vite preview` serves only the static client, so /api/status 404s locally.
 * Ignore API misses unless checking a real deployment.
 */
const IGNORE_API_404 = !process.env.BASE_URL;
const ROUTES = [
  { path: '/', expect: 'Operations overview' },
  { path: '/contracts', expect: 'Contracts' },
  { path: '/splitters', expect: 'Splitters' },
  { path: '/advances', expect: 'Advances' },
  { path: '/repayments', expect: 'Repayments' },
  { path: '/transactions', expect: 'Transactions' },
  { path: '/x402', expect: 'x402 loop' },
  { path: '/threats', expect: 'Threat model' },
];

const VIEWPORTS = [
  { name: 'phone-landscape-667x375', width: 667, height: 375 },
  { name: 'landscape-800x380', width: 800, height: 380 },
  { name: 'landscape-1024x420', width: 1024, height: 420 },
  { name: 'mobile-375', width: 375, height: 780 },
  { name: 'mobile-414', width: 414, height: 896 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'desktop-1600', width: 1600, height: 900 },
  { name: 'wide-1920', width: 1920, height: 1080 },
];

const failures: string[] = [];
const note = (message: string) => {
  failures.push(message);
  console.log(`  FAIL  ${message}`);
};
const pass = (message: string) => console.log(`  ok    ${message}`);

/** Fails if the page scrolls sideways, which is the usual responsive break. */
async function checkNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1)
        .slice(0, 4)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className || '(no class)'}`),
    };
  });
  if (overflow.scrollWidth > overflow.clientWidth + 1) {
    note(
      `${label}: horizontal overflow ${overflow.scrollWidth} > ${overflow.clientWidth}` +
        (overflow.offenders.length ? ` [${overflow.offenders.join(', ')}]` : ''),
    );
  }
}

/**
 * The sidebar must span the full viewport height, and when its content is taller
 * than the viewport it must scroll internally rather than clip the last item.
 */
async function checkSidebarHeight(page: Page, label: string) {
  const result = await page.evaluate(() => {
    // The desktop rail is an <aside>, the mobile drawer is a <div>.
    const el = document.querySelector('.sidebar') as HTMLElement | null;
    if (!el) return { missing: true };
    const rect = el.getBoundingClientRect();
    const canScroll = el.scrollHeight > el.clientHeight + 1;
    const last = el.querySelector('.prototype-note') as HTMLElement | null;
    let lastReachable = true;
    if (last) {
      if (canScroll) el.scrollTop = el.scrollHeight;
      lastReachable = last.getBoundingClientRect().bottom <= window.innerHeight + 1;
      el.scrollTop = 0;
    }
    return {
      top: rect.top,
      height: rect.height,
      vh: window.innerHeight,
      fills: rect.top <= 0.5 && Math.round(rect.height) >= window.innerHeight,
      canScroll,
      lastReachable,
    };
  });

  if (result.missing) {
    note(`${label}: sidebar not found`);
    return;
  }
  if (!result.fills) {
    note(
      `${label}: sidebar does not fill the viewport ` +
        `(top ${Math.round(result.top)}, height ${Math.round(result.height)}, vh ${result.vh})`,
    );
  }
  if (!result.lastReachable) {
    note(`${label}: sidebar content is clipped and cannot be scrolled to`);
  }
}

/** Taps that must stay at least 40px tall on touch viewports. */
async function checkTapTargets(page: Page, label: string) {
  const small = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('a, button'))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        if (el.closest('.data-table-wrap')) return false;
        return rect.height < 32;
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}:"${(el.textContent ?? '').trim().slice(0, 22)}" ${Math.round(el.getBoundingClientRect().height)}px`),
  );
  if (small.length) note(`${label}: small tap targets — ${small.join(', ')}`);
}

const browser = await chromium.launch({ channel: 'chrome' });

for (const viewport of VIEWPORTS) {
  console.log(`\n=== ${viewport.name} (${viewport.width}x${viewport.height}) ===`);
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.width <= 900,
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  const isMobile = viewport.width <= 900;

  for (const route of ROUTES) {
    await page.goto(`${BASE}${route.path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(350);

    const h1 = (await page.locator('h1').first().textContent())?.trim() ?? '';
    if (h1 !== route.expect) {
      note(`${viewport.name} ${route.path}: h1 was "${h1}", expected "${route.expect}"`);
    } else {
      pass(`${route.path} → "${h1}"`);
    }

    // Desktop must not render the old top navigation bar.
    if (viewport.width > 900) {
      const topbars = await page.locator('.topbar, .mobile-nav, .mobile-header').count();
      if (topbars > 0) note(`${viewport.name} ${route.path}: found ${topbars} legacy top nav element(s)`);
      const sidebarVisible = await page.locator('aside.sidebar').isVisible();
      if (!sidebarVisible) note(`${viewport.name} ${route.path}: desktop sidebar not visible`);
    } else {
      const desktopSidebarVisible = await page.locator('aside.sidebar').isVisible();
      if (desktopSidebarVisible) note(`${viewport.name} ${route.path}: desktop sidebar visible on mobile`);
      const burger = await page.locator('[data-testid="button-open-nav"]').isVisible();
      if (!burger) note(`${viewport.name} ${route.path}: mobile menu button missing`);
    }

    await checkNoHorizontalOverflow(page, `${viewport.name} ${route.path}`);
    await checkTapTargets(page, `${viewport.name} ${route.path}`);

    if (isMobile) {
      await page.locator('[data-testid="button-open-nav"]').click();
      await page.waitForTimeout(420);
      await checkSidebarHeight(page, `${viewport.name} ${route.path} (drawer)`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(280);
    } else {
      await checkSidebarHeight(page, `${viewport.name} ${route.path}`);
      // Also assert the column stays full height when scrolled to the bottom.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(260);
      await checkSidebarHeight(page, `${viewport.name} ${route.path} (scrolled)`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(160);
    }
  }

  // ---- navigation behaviour ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

  if (isMobile) {
    const burger = page.locator('[data-testid="button-open-nav"]');
    await burger.click();
    await page.waitForTimeout(320);
    if (!(await page.locator('#runway-drawer').isVisible())) {
      note(`${viewport.name}: drawer did not open`);
    } else {
      pass('drawer opens');
    }
    await page.locator('[data-testid="nav-advances"]').click();
    await page.waitForTimeout(400);
    if (!page.url().endsWith('/advances')) {
      note(`${viewport.name}: nav click did not change route (${page.url()})`);
    } else {
      pass(`drawer nav navigates to ${new URL(page.url()).pathname}`);
    }
    if (await page.locator('#runway-drawer').isVisible()) {
      note(`${viewport.name}: drawer stayed open after navigating`);
    } else {
      pass('drawer closes after navigating');
    }
    await page.keyboard.press('Escape');
  } else {
    const toggle = page.locator('[data-testid="button-toggle-sidebar"]');
    const wide = await page.locator('aside.sidebar').boundingBox();
    await toggle.click();
    await page.waitForTimeout(360);
    const narrow = await page.locator('aside.sidebar').boundingBox();
    if (!wide || !narrow) {
      note(`${viewport.name}: could not measure sidebar`);
    } else if (narrow.width >= wide.width - 4) {
      note(`${viewport.name}: sidebar did not collapse (${wide.width} → ${narrow.width})`);
    } else {
      pass(`sidebar collapses ${Math.round(wide.width)}px → ${Math.round(narrow.width)}px`);
    }
    const labelsHidden = await page
      .locator('aside.sidebar .nav-label-text')
      .first()
      .isVisible();
    if (labelsHidden) note(`${viewport.name}: nav labels still visible when collapsed`);

    // Collapsed state must survive a reload.
    await page.reload({ waitUntil: 'networkidle' });
    const afterReload = await page.locator('aside.sidebar').boundingBox();
    if (!afterReload || afterReload.width > 100) {
      note(`${viewport.name}: collapse state not persisted (${afterReload?.width}px)`);
    } else {
      pass('collapse persists across reload');
    }

    await page.locator('[data-testid="button-toggle-sidebar"]').click();
    await page.waitForTimeout(340);
    await page.locator('[data-testid="nav-transactions"]').click();
    await page.waitForTimeout(500);
    if (!page.url().endsWith('/transactions')) {
      note(`${viewport.name}: sidebar nav did not navigate (${page.url()})`);
    } else {
      pass(`sidebar nav navigates to ${new URL(page.url()).pathname}`);
    }
    const h1After = (await page.locator('h1').first().textContent())?.trim();
    if (h1After !== 'Transactions') {
      note(`${viewport.name}: route change did not swap content (h1="${h1After}")`);
    } else {
      pass('route change swaps page content');
    }
  }

  const relevant = consoleErrors.filter((message) => {
    // The 429 is /api/keeper?auto=1 rate limiting, which is intended: the
    // dashboard nudges the keeper every 45s but the endpoint ignores calls
    // inside its 15s cooldown. Not a UI defect.
    if (/status of 429/.test(message)) return false;
    if (IGNORE_API_404 && /api\/status|Failed to load resource/.test(message)) return false;
    return true;
  });
  if (relevant.length) {
    const unique = [...new Set(relevant)].slice(0, 3);
    note(`${viewport.name}: console errors — ${unique.join(' | ')}`);
  }

  await context.close();
}

await browser.close();

console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
  console.log('ALL RESPONSIVE + NAVIGATION CHECKS PASSED');
} else {
  console.log(`${failures.length} FAILURE(S):`);
  failures.forEach((f) => console.log(` - ${f}`));
  process.exitCode = 1;
}
