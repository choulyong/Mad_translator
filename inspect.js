const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('http://localhost:3033/library', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  console.log('📋 페이지 구조 분석\n');

  // 이미지 찾기
  const images = await page.locator('img').all();
  console.log(`총 이미지: ${images.length}개\n`);

  console.log('첫 5개 이미지:');
  for (let i = 0; i < Math.min(5, images.length); i++) {
    const alt = await images[i].getAttribute('alt');
    const src = await images[i].getAttribute('src');
    console.log(`  [${i}] alt="${alt}" src="${src ? src.substring(0, 50) : 'none'}..."`);
  }

  // 클릭 가능한 요소
  const clickables = await page.locator('div[role], button, a, [onclick]').all();
  console.log(`\n클릭 가능 요소: ${clickables.length}개`);

  // 텍스트 콘텐츠 샘플
  const text = await page.locator('body').textContent();
  if (text.includes('히트맨')) {
    console.log('✅ 영화 데이터 있음');
  } else {
    console.log('❌ 영화 데이터 없음');
  }

  await browser.close();
})();
