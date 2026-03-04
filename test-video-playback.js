const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const networkLog = [];

  page.on('response', res => {
    if (res.url().includes('stream')) {
      const status = res.status();
      const type = res.url().includes('hls') ? 'M3U8' : res.url().includes('hls-seg') ? 'SEG' : res.url().includes('hls-init') ? 'INIT' : 'OTHER';
      networkLog.push(`${status} ${type}`);
    }
  });

  try {
    console.log('🎬 히트맨 2 재생 테스트\n');

    await page.goto('http://localhost:3033/library', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // 히트맨 포스터 클릭해서 모달 열기
    console.log('🎯 히트맨 2 포스터 클릭...');
    const hitmanCard = await page.locator('text=히트맨').first();
    const cardParent = await hitmanCard.locator('xpath=ancestor::div[contains(@class, "")][5]').first();

    await cardParent.click().catch(async () => {
      // 실패하면 히트맨 텍스트 자체를 클릭
      await hitmanCard.click();
    });

    await page.waitForTimeout(2000);
    console.log('✅ 클릭됨\n');

    // 모달 확인
    const modal = await page.locator('[role="dialog"]').first();
    const hasModal = await modal.isVisible().catch(() => false);

    if (hasModal) {
      console.log('✅ 모달 열림');

      // 모달 내 모든 버튼 나열
      const btns = await modal.locator('button').all();
      console.log(`📌 모달 버튼: ${btns.length}개\n`);

      for (let i = 0; i < btns.length; i++) {
        const text = await btns[i].textContent();
        const visible = await btns[i].isVisible().catch(() => false);
        console.log(`   [${i}] "${text}" ${visible ? '✓' : '✗'}`);

        // 첫 번째 버튼 (아마도 재생 버튼)
        if (i === 0 && visible) {
          console.log('\n▶️  첫 번째 버튼 클릭...');
          await btns[i].click();
          await page.waitForTimeout(4000);
          console.log('✅ 클릭됨\n');
          break;
        }
      }
    } else {
      console.log('❌ 모달을 열 수 없습니다\n');
    }

    // 에러 확인
    const pageText = await page.locator('body').textContent();
    if (pageText.includes('비디오를 재생할 수 없습니다')) {
      console.log('❌ ERROR 4 발생: 비디오를 재생할 수 없습니다');
    } else if (pageText.includes('Error')) {
      console.log('❌ 다른 에러 발생');
    } else {
      console.log('✅ 에러 없음');
    }

    // 네트워크
    console.log('\n📡 API 응답:');
    if (networkLog.length > 0) {
      networkLog.forEach(log => console.log('   ' + log));
    } else {
      console.log('   (요청 없음)');
    }

    await page.screenshot({ path: '/tmp/hitman-play-test.png' });
    console.log('\n📸 /tmp/hitman-play-test.png');

  } catch (err) {
    console.error('\n❌ 에러:', err.message);
  }

  await browser.close();
})();
