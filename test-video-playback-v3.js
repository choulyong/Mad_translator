const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const context = await browser.newContext();
  const ctxPage = await context.newPage();

  // 네트워크 모니터링
  const streamRequests = [];

  ctxPage.on('response', async res => {
    const url = res.url();
    const status = res.status();

    if (url.includes('stream')) {
      streamRequests.push({ url, status, time: new Date().toISOString() });
      console.log(`📡 [${status}] ${url.substring(url.lastIndexOf('/') + 1)}`);
    }
  });

  try {
    console.log('🎬 히트맨 2 비디오 재생 테스트 (v3 - 포스터 호버 직접)\n');
    console.log('📍 Step 1: 라이브러리 로드');
    await ctxPage.goto('http://localhost:3033/library', { waitUntil: 'networkidle' });
    await ctxPage.waitForTimeout(2000);
    console.log('✅ 라이브러리 로드 완료\n');

    console.log('📍 Step 2: 히트맨 2 포스터 클릭 (모달 열기)');
    const hitmanText = await ctxPage.locator('text=히트맨').first();
    if (!await hitmanText.isVisible()) {
      throw new Error('히트맨 텍스트를 찾을 수 없습니다');
    }
    await hitmanText.click();
    await ctxPage.waitForTimeout(2500);
    console.log('✅ 클릭 완료\n');

    // 스크린샷: 모달 열림
    await ctxPage.screenshot({ path: '/tmp/v3-step2-modal-open.png' });
    console.log('📸 /tmp/v3-step2-modal-open.png\n');

    console.log('📍 Step 3: 페이지에서 모든 이미지 찾기 (포스터 탐지)');
    const allImages = await ctxPage.locator('img').all();
    console.log(`   총 ${allImages.length}개 이미지 발견`);

    let posterImg = null;
    for (let i = 0; i < Math.min(10, allImages.length); i++) {
      const img = allImages[i];
      const visible = await img.isVisible().catch(() => false);
      const src = await img.getAttribute('src').catch(() => '');
      const alt = await img.getAttribute('alt').catch(() => '');

      if (visible) {
        console.log(`   [${i}] visible - src: ${src.substring(0, 40)}... alt: "${alt}"`);

        // 포스터는 보통 src에 poster, cover, thumbnail 등이 포함됨
        if (src.includes('poster') || src.includes('cover') || src.includes('thumb') || alt.includes('히트맨') || alt.includes('Hitman')) {
          posterImg = img;
          console.log(`   ✓ [${i}]번이 포스터로 추정됨`);
          break;
        }
      }
    }

    if (!posterImg) {
      console.log('   포스터가 명확하지 않음, 첫 번째 visible 이미지 사용');
      for (let i = 0; i < allImages.length; i++) {
        if (await allImages[i].isVisible().catch(() => false)) {
          posterImg = allImages[i];
          console.log(`   ✓ [${i}]번 사용`);
          break;
        }
      }
    }

    if (!posterImg) {
      throw new Error('포스터 이미지를 찾을 수 없습니다');
    }
    console.log('✅ 포스터 발견\n');

    console.log('📍 Step 4: 포스터에 마우스 올리기 (hover overlay 표시)');
    const posterBox = await posterImg.boundingBox();
    if (posterBox) {
      console.log(`   포스터 위치: x=${Math.round(posterBox.x)}, y=${Math.round(posterBox.y)}, w=${Math.round(posterBox.width)}, h=${Math.round(posterBox.height)}`);

      // 포스터 중앙에 hover
      await ctxPage.mouse.move(posterBox.x + posterBox.width / 2, posterBox.y + posterBox.height / 2);
      await ctxPage.waitForTimeout(1500);
      console.log('✅ Hover 완료\n');

      // 스크린샷: hover 후
      await ctxPage.screenshot({ path: '/tmp/v3-step4-hover.png' });
      console.log('📸 /tmp/v3-step4-hover.png\n');
    }

    console.log('📍 Step 5: 재생 버튼 찾기');

    // 페이지의 모든 버튼 나열
    const allButtons = await ctxPage.locator('button').all();
    console.log(`   총 ${allButtons.length}개 버튼 발견`);

    let playBtn = null;
    for (let i = 0; i < allButtons.length; i++) {
      const btn = allButtons[i];
      const visible = await btn.isVisible().catch(() => false);
      const text = await btn.textContent().catch(() => '');
      const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');

      if (visible && (text || ariaLabel)) {
        const btnInfo = text ? `"${text.trim().substring(0, 20)}"` : `aria: "${ariaLabel.substring(0, 20)}"`;
        console.log(`   [${i}] ${btnInfo}`);

        // 재생 버튼 찾기
        if (text.includes('재') || text.includes('play') || text.includes('▶') ||
            ariaLabel.includes('재') || ariaLabel.includes('play')) {
          playBtn = btn;
          console.log(`   ✓ [${i}]번이 재생 버튼으로 추정됨`);
          break;
        }
      }
    }

    if (!playBtn) {
      console.log('   명확한 재생 버튼 없음, 첫 번째 visible 버튼 시도\n');
      for (let i = 0; i < allButtons.length; i++) {
        if (await allButtons[i].isVisible().catch(() => false)) {
          playBtn = allButtons[i];
          console.log(`   ✓ [${i}]번 버튼 사용\n`);
          break;
        }
      }
    }

    if (playBtn) {
      console.log('✅ 재생 버튼 발견\n');

      console.log('📍 Step 6: 재생 버튼 클릭');
      await playBtn.click();
      await ctxPage.waitForTimeout(4000);
      console.log('✅ 클릭 완료\n');

      // 스크린샷: 재생 후
      await ctxPage.screenshot({ path: '/tmp/v3-step6-play-clicked.png' });
      console.log('📸 /tmp/v3-step6-play-clicked.png\n');
    } else {
      console.log('⚠️  재생 버튼을 찾을 수 없습니다\n');
    }

    // 네트워크 상태 확인
    console.log('📍 Step 7: HLS 스트림 요청 확인');
    await ctxPage.waitForTimeout(2000);

    if (streamRequests.length > 0) {
      console.log(`✅ HLS 스트림 요청 감지: ${streamRequests.length}개`);
      streamRequests.slice(0, 10).forEach((req, idx) => {
        const urlPart = req.url.substring(req.url.indexOf('stream'));
        console.log(`   [${idx + 1}] ${req.status} ${urlPart.substring(0, 60)}`);
      });
    } else {
      console.log('⚠️  HLS 스트림 요청이 없습니다');
    }

    // 에러 확인
    console.log('\n📍 Step 8: 페이지 에러 확인');
    const pageText = await ctxPage.locator('body').textContent();

    let hasError = false;
    if (pageText.includes('Error 4') || pageText.includes('비디오를 재생할 수 없습니다')) {
      console.log('❌ ERROR 4: 비디오를 재생할 수 없습니다');
      hasError = true;
    } else if (pageText.includes('Error')) {
      console.log('⚠️  다른 에러 감지');
      hasError = true;
    } else {
      console.log('✅ 에러 없음');
    }

    // 최종 스크린샷
    await ctxPage.screenshot({ path: '/tmp/v3-step8-final.png' });
    console.log('📸 /tmp/v3-step8-final.png\n');

    // 결과 요약
    console.log('════════════════════════════════════════');
    console.log('📊 테스트 결과 요약:');
    console.log('════════════════════════════════════════');
    console.log(`✅ 라이브러리 로드: 성공`);
    console.log(`✅ 모달 열림: 성공`);
    console.log(`✅ 포스터 hover: 성공`);
    console.log(`${playBtn ? '✅' : '⚠️ '} 재생 버튼 클릭: ${playBtn ? '성공' : '감지 실패'}`);
    console.log(`${streamRequests.length > 0 ? '✅' : '⚠️ '} HLS 스트림: ${streamRequests.length > 0 ? `${streamRequests.length}개 요청` : '요청 없음'}`);
    console.log(`${!hasError ? '✅' : '❌'} Error 4: ${!hasError ? '없음' : '발생'}`);
    console.log('════════════════════════════════════════\n');

  } catch (err) {
    console.error('\n❌ 테스트 실패:', err.message);
    await ctxPage.screenshot({ path: '/tmp/v3-error-screenshot.png' });
    console.log('📸 /tmp/v3-error-screenshot.png');
  }

  await ctxPage.close();
  await context.close();
  await browser.close();
})();
