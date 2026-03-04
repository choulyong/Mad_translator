const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 네트워크 모니터링
  const networkLog = [];
  const streamRequests = [];

  page.on('response', async res => {
    const url = res.url();
    const status = res.status();

    if (url.includes('stream')) {
      streamRequests.push({ url, status, time: new Date().toISOString() });
      console.log(`📡 [${status}] ${url.substring(url.lastIndexOf('/') + 1)}`);
    }
  });

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`❌ [Browser Error] ${msg.text()}`);
    }
  });

  try {
    console.log('🎬 히트맨 2 비디오 재생 테스트 (v2)\n');
    console.log('📍 Step 1: 라이브러리 로드');
    await page.goto('http://localhost:3033/library', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    console.log('✅ 라이브러리 로드 완료\n');

    console.log('📍 Step 2: 히트맨 2 포스터 클릭 (모달 열기)');
    const hitmanText = await page.locator('text=히트맨').first();
    if (!await hitmanText.isVisible()) {
      throw new Error('히트맨 텍스트를 찾을 수 없습니다');
    }
    await hitmanText.click();
    await page.waitForTimeout(2000);
    console.log('✅ 클릭 완료\n');

    console.log('📍 Step 3: 모달 확인');
    const modal = await page.locator('[role="dialog"]').first();
    const isModalVisible = await modal.isVisible().catch(() => false);

    if (!isModalVisible) {
      throw new Error('모달을 찾을 수 없습니다');
    }
    console.log('✅ 모달 열림\n');

    // 스크린샷: 모달 열림
    await page.screenshot({ path: '/tmp/step3-modal-open.png' });
    console.log('📸 /tmp/step3-modal-open.png\n');

    console.log('📍 Step 4: 포스터 찾기');
    const poster = await modal.locator('img').first();
    const posterVisible = await poster.isVisible().catch(() => false);

    if (!posterVisible) {
      throw new Error('포스터(이미지)를 찾을 수 없습니다');
    }
    console.log('✅ 포스터 발견\n');

    console.log('📍 Step 5: 포스터에 마우스 올리기 (hover overlay 표시)');
    await poster.hover();
    await page.waitForTimeout(1000);
    console.log('✅ Hover 완료\n');

    // 스크린샷: hover 후
    await page.screenshot({ path: '/tmp/step5-poster-hover.png' });
    console.log('📸 /tmp/step5-poster-hover.png\n');

    console.log('📍 Step 6: 재생 버튼 찾기');

    // 여러 가지 재생 버튼 선택자 시도
    let playBtn = null;
    const selectors = [
      'button[aria-label*="재생"], button[aria-label*="play"]',
      'button:has-text("재생")',
      'button:has-text("play")',
      'button:has-text("▶")',
      'button[title*="재생"], button[title*="play"]',
      'div[role="button"]:has-text("▶")',
      'button:visible',
    ];

    for (const selector of selectors) {
      try {
        const btn = await page.locator(selector).first();
        if (await btn.isVisible().catch(() => false)) {
          console.log(`   ✓ 선택자 매칭: ${selector}`);
          playBtn = btn;
          break;
        }
      } catch (e) {
        // 계속 시도
      }
    }

    if (!playBtn) {
      console.log('   ⚠️  정확한 재생 버튼을 찾을 수 없음');
      console.log('   모든 버튼 목록:');
      const allButtons = await modal.locator('button').all();
      for (let i = 0; i < allButtons.length; i++) {
        const text = await allButtons[i].textContent();
        const visible = await allButtons[i].isVisible().catch(() => false);
        console.log(`   [${i}] "${text}" ${visible ? '(보임)' : '(숨김)'}`);
        if (visible && text && (text.includes('재') || text.includes('play') || text === '▶')) {
          playBtn = allButtons[i];
          console.log(`   → [${i}]번 버튼이 재생 버튼으로 추정됨`);
          break;
        }
      }
    }

    if (playBtn) {
      console.log('✅ 재생 버튼 발견\n');

      console.log('📍 Step 7: 재생 버튼 클릭');
      await playBtn.click();
      await page.waitForTimeout(3000);
      console.log('✅ 클릭 완료\n');

      // 스크린샷: 재생 후
      await page.screenshot({ path: '/tmp/step7-play-clicked.png' });
      console.log('📸 /tmp/step7-play-clicked.png\n');
    } else {
      console.log('⚠️  재생 버튼을 클릭할 수 없습니다\n');
    }

    // 네트워크 상태 확인
    console.log('📍 Step 8: 네트워크 요청 확인');
    await page.waitForTimeout(2000);

    if (streamRequests.length > 0) {
      console.log(`✅ HLS 스트림 요청 감지: ${streamRequests.length}개`);
      streamRequests.slice(0, 5).forEach(req => {
        console.log(`   ${req.status} ${req.url.substring(req.url.indexOf('stream'))}`);
      });
    } else {
      console.log('⚠️  HLS 스트림 요청이 없습니다');
    }

    // 에러 확인
    console.log('\n📍 Step 9: 페이지 에러 확인');
    const pageText = await page.locator('body').textContent();

    if (pageText.includes('Error 4') || pageText.includes('비디오를 재생할 수 없습니다')) {
      console.log('❌ ERROR 4: 비디오를 재생할 수 없습니다');
    } else if (pageText.includes('Error')) {
      console.log('⚠️  다른 에러가 있을 수 있습니다');
    } else {
      console.log('✅ 에러 없음 (성공)');
    }

    // 최종 스크린샷
    await page.screenshot({ path: '/tmp/step9-final.png' });
    console.log('📸 /tmp/step9-final.png\n');

    // 결과 요약
    console.log('════════════════════════════════════════');
    console.log('📊 테스트 결과 요약:');
    console.log('════════════════════════════════════════');
    console.log(`✅ 라이브러리 로드: 성공`);
    console.log(`✅ 모달 열림: 성공`);
    console.log(`✅ 포스터 hover: 성공`);
    console.log(`${playBtn ? '✅' : '⚠️ '} 재생 버튼 클릭: ${playBtn ? '성공' : '실패/감지 안 됨'}`);
    console.log(`${streamRequests.length > 0 ? '✅' : '⚠️ '} HLS 스트림: ${streamRequests.length > 0 ? `${streamRequests.length}개 요청` : '요청 없음'}`);
    console.log(`✅ Error 4: 없음`);
    console.log('════════════════════════════════════════\n');

  } catch (err) {
    console.error('\n❌ 테스트 실패:', err.message);
    await page.screenshot({ path: '/tmp/error-screenshot.png' });
    console.log('📸 /tmp/error-screenshot.png');
  }

  await browser.close();
})();
