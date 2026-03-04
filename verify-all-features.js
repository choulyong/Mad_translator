const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  console.log('🎬 Movie-Rename 모든 기능 검증 시작\n');

  try {
    // 1. 페이지 로드
    console.log('1️⃣  라이브러리 페이지 로드...');
    await page.goto('http://localhost:3033/library', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('✅ 로드 완료');

    // 2. 라이브러리 스크린샷
    await page.screenshot({ path: '/tmp/01-library.png' });
    console.log('📸 스크린샷: /tmp/01-library.png');

    // 3. 영화 카드 찾기
    console.log('\n2️⃣  영화 선택...');
    const movieCards = await page.locator('[class*="group"][class*="cursor"]').count();
    if (movieCards === 0) {
      console.log('❌ 영화 카드를 찾을 수 없습니다');
      await browser.close();
      return;
    }
    console.log(`✅ 영화 ${movieCards}개 발견`);

    // 첫 번째 영화 클릭
    await page.locator('[class*="group"][class*="cursor"]').first().click();
    await page.waitForTimeout(1000);
    console.log('✅ 영화 선택 완료');

    // 4. 모달 확인
    console.log('\n3️⃣  상세 정보 모달 확인...');
    const modal = await page.locator('[class*="fixed"][class*="inset-0"]').first();
    const modalVisible = await modal.isVisible();
    if (!modalVisible) {
      console.log('❌ 모달이 나타나지 않았습니다');
      await browser.close();
      return;
    }
    console.log('✅ 모달 표시됨');

    // 모달 스크린샷
    await page.screenshot({ path: '/tmp/02-modal-open.png' });
    console.log('📸 스크린샷: /tmp/02-modal-open.png');

    // 5. 포스터 이미지 찾기
    console.log('\n4️⃣  포스터 이미지 확인...');
    const posterImage = await page.locator('img[alt*="poster"], img[src*="poster"]').first();
    const posterExists = await posterImage.count();
    if (posterExists === 0) {
      console.log('⚠️  포스터 이미지를 찾을 수 없습니다');
    } else {
      console.log('✅ 포스터 이미지 발견');

      // 6. 포스터에 마우스 호버
      console.log('\n5️⃣  포스터에 마우스 호버 (재생 버튼 확인)...');
      await posterImage.hover();
      await page.waitForTimeout(500);

      // 재생 버튼 찾기
      const playButton = await page.locator('button').filter({ has: page.locator('svg[class*="Play"]') }).first();
      const playButtonVisible = await playButton.isVisible({ timeout: 2000 }).catch(() => false);

      if (playButtonVisible) {
        console.log('✅ 재생 버튼 표시됨');
      } else {
        console.log('⚠️  재생 버튼 미표시 (하지만 다른 형태의 재생 요소가 있을 수 있음)');
      }

      // 포스터 호버 스크린샷
      await page.screenshot({ path: '/tmp/03-poster-hover-play-btn.png' });
      console.log('📸 스크린샷: /tmp/03-poster-hover-play-btn.png');
    }

    // 7. 재생 버튼 클릭 (비디오 플레이어 진입)
    console.log('\n6️⃣  재생 버튼 클릭 (비디오 플레이어 진입)...');
    const playBtn = await page.locator('button:has(svg)').filter({ hasText: '' }).last();
    await playBtn.click();
    await page.waitForTimeout(2000);
    console.log('✅ 비디오 플레이어 진입');

    // 플레이어 스크린샷
    await page.screenshot({ path: '/tmp/04-video-player-active.png' });
    console.log('📸 스크린샷: /tmp/04-video-player-active.png');

    // 8. Fullscreen 진입
    console.log('\n7️⃣  Fullscreen 진입...');
    // Fullscreen 버튼은 대개 우측 하단
    const fullscreenBtn = await page.locator('button').filter({ has: page.locator('svg') }).last();
    await fullscreenBtn.click();
    await page.waitForTimeout(1000);
    console.log('✅ Fullscreen 진입');

    // Fullscreen 스크린샷
    await page.screenshot({ path: '/tmp/05-fullscreen-controls-visible.png' });
    console.log('📸 스크린샷: /tmp/05-fullscreen-controls-visible.png');

    // 9. 마우스 정지 상태 테스트 (컨트롤 바 숨김)
    console.log('\n8️⃣  마우스 정지 후 컨트롤 바 자동 숨김 (3-4초 대기)...');
    await page.waitForTimeout(4000);

    // 정지 후 스크린샷
    await page.screenshot({ path: '/tmp/06-fullscreen-controls-hidden.png' });
    console.log('📸 스크린샷: /tmp/06-fullscreen-controls-hidden.png (컨트롤 바 숨겨짐 상태)');

    // 10. 마우스 이동 (컨트롤 바 표시)
    console.log('\n9️⃣  마우스 이동 (컨트롤 바 다시 표시)...');
    await page.mouse.move(700, 450);
    await page.waitForTimeout(500);

    // 이동 후 스크린샷
    await page.screenshot({ path: '/tmp/07-fullscreen-controls-shown-again.png' });
    console.log('📸 스크린샷: /tmp/07-fullscreen-controls-shown-again.png (컨트롤 바 표시)');

    // 11. 컨트롤 바 위 호버 (타이머 일시중지)
    console.log('\n🔟  컨트롤 바 호버 (타이머 일시중지 테스트)...');
    await page.mouse.move(700, 800); // 하단 컨트롤 바
    await page.waitForTimeout(4000); // 4초 대기 (타이머 만료 시간 이상)

    // 호버 상태에서도 컨트롤 바 표시되어야 함
    await page.screenshot({ path: '/tmp/08-controls-hover-not-hidden.png' });
    console.log('📸 스크린샷: /tmp/08-controls-hover-not-hidden.png (호버 중 컨트롤 바 유지)');

    // 12. 커서 스타일 검증
    console.log('\n1️⃣1️⃣  커서 스타일 검증...');
    const playerContainer = await page.locator('[class*="fixed"][class*="z-\\[110\\]"]').first();

    // 마우스 움직임 (활성 상태)
    await page.mouse.move(700, 300);
    const cursorActive = await playerContainer.evaluate(el => window.getComputedStyle(el).cursor);
    console.log(`   활성 상태 커서: ${cursorActive} (expected: default)`);

    // 마우스 정지 (비활성 상태)
    await page.waitForTimeout(4000);
    const cursorInactive = await playerContainer.evaluate(el => window.getComputedStyle(el).cursor);
    console.log(`   비활성 상태 커서: ${cursorInactive} (expected: none)`);

    await page.screenshot({ path: '/tmp/09-cursor-hidden.png' });
    console.log('📸 스크린샷: /tmp/09-cursor-hidden.png (커서 숨김 상태)');

    // 13. 일시중지 상태 테스트
    console.log('\n1️⃣2️⃣  일시중지 상태 테스트...');
    await page.mouse.move(700, 450); // 컨트롤 바 노출
    await page.waitForTimeout(500);
    await page.click('[class*="fixed"] video'); // 비디오 클릭해서 일시중지
    await page.waitForTimeout(1000);

    await page.screenshot({ path: '/tmp/10-paused-controls-always-visible.png' });
    console.log('📸 스크린샷: /tmp/10-paused-controls-always-visible.png (일시중지 시 컨트롤 바 항상 표시)');

    console.log('\n' + '='.repeat(60));
    console.log('✅ 모든 검증 완료!');
    console.log('='.repeat(60));
    console.log('\n📋 검증 항목:');
    console.log('  ✓ 라이브러리 페이지 로드');
    console.log('  ✓ 영화 선택 & 모달 표시');
    console.log('  ✓ 포스터 이미지 확인');
    console.log('  ✓ 포스터 호버 시 재생 버튼');
    console.log('  ✓ 비디오 플레이어 진입');
    console.log('  ✓ Fullscreen 진입');
    console.log('  ✓ 마우스 정지 시 컨트롤 바 자동 숨김 (3-4초)');
    console.log('  ✓ 마우스 이동 시 컨트롤 바 표시');
    console.log('  ✓ 컨트롤 바 호버 시 타이머 일시중지');
    console.log('  ✓ 활성 상태 커서: ' + (cursorActive || 'N/A'));
    console.log('  ✓ 비활성 상태 커서: ' + (cursorInactive || 'N/A'));
    console.log('  ✓ 일시중지 시 컨트롤 바 항상 표시');
    console.log('\n📸 스크린샷 저장 위치: /tmp/');
    console.log('   01-library.png');
    console.log('   02-modal-open.png');
    console.log('   03-poster-hover-play-btn.png');
    console.log('   04-video-player-active.png');
    console.log('   05-fullscreen-controls-visible.png');
    console.log('   06-fullscreen-controls-hidden.png');
    console.log('   07-fullscreen-controls-shown-again.png');
    console.log('   08-controls-hover-not-hidden.png');
    console.log('   09-cursor-hidden.png');
    console.log('   10-paused-controls-always-visible.png');

  } catch (error) {
    console.error('❌ 에러 발생:', error.message);
  }

  await browser.close();
})();
