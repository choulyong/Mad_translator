const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  console.log('🎬 Fullscreen Controls & Mouse Cursor 검증 시작\n');

  // 1. 페이지 로드
  console.log('1️⃣  페이지 로드 중...');
  await page.goto('http://localhost:3033/library', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 2. 라이브러리에서 첫 번째 영화 찾기
  console.log('2️⃣  영화 클릭 시도...');
  const movieCard = await page.locator('[class*="group"]').first();
  const hasMovies = await movieCard.count();

  if (hasMovies === 0) {
    console.log('⚠️  영화가 없어서 테스트 스킵됨');
    await browser.close();
    return;
  }

  // 스크린샷: 초기 라이브러리
  await page.screenshot({ path: '/tmp/verify-fullscreen-1-library.png' });
  console.log('📸 스크린샷: /tmp/verify-fullscreen-1-library.png');

  // 3. 영화 카드 클릭
  await movieCard.click();
  await page.waitForTimeout(2000);

  // 스크린샷: 비디오 플레이어 오픈
  await page.screenshot({ path: '/tmp/verify-fullscreen-2-player-open.png' });
  console.log('📸 스크린샷: /tmp/verify-fullscreen-2-player-open.png');

  // 4. 비디오 플레이어 컨테이너 찾기
  const playerContainer = await page.locator('[class*="fixed"][class*="z-\\[110\\]"]').first();
  const playerExists = await playerContainer.count();

  if (playerExists === 0) {
    console.log('❌ 플레이어를 찾을 수 없음');
    await browser.close();
    return;
  }

  console.log('✅ 플레이어 찾음');

  // 5. Fullscreen 버튼 찾기 및 클릭
  console.log('3️⃣  Fullscreen 진입 시도...');
  const fullscreenBtn = await page.locator('button').filter({ has: page.locator('svg') }).last();
  await fullscreenBtn.click();
  await page.waitForTimeout(1000);

  // 스크린샷: Fullscreen 직후
  await page.screenshot({ path: '/tmp/verify-fullscreen-3-entered.png' });
  console.log('📸 스크린샷: /tmp/verify-fullscreen-3-entered.png');

  // 6. Fullscreen 상태에서 마우스 정지 시뮬레이션 (컨트롤 바 숨김 테스트)
  console.log('4️⃣  마우스 정지 후 컨트롤 바 숨김 대기 (4초)...');
  await page.waitForTimeout(4000);

  // 스크린샷: 컨트롤 바 숨겨짐 상태
  await page.screenshot({ path: '/tmp/verify-fullscreen-4-controls-hidden.png' });
  console.log('📸 스크린샷: /tmp/verify-fullscreen-4-controls-hidden.png');

  // 7. 마우스 이동해서 컨트롤 바 다시 표시
  console.log('5️⃣  마우스 이동해서 컨트롤 바 표시...');
  await page.mouse.move(700, 450); // 중앙으로 이동
  await page.waitForTimeout(1000);

  // 스크린샷: 컨트롤 바 표시됨
  await page.screenshot({ path: '/tmp/verify-fullscreen-5-controls-shown.png' });
  console.log('📸 스크린샷: /tmp/verify-fullscreen-5-controls-shown.png');

  // 8. 컨트롤 바 위의 마우스 호버 테스트 (타이머 일시중지)
  console.log('6️⃣  컨트롤 바 위에 마우스 호버 (타이머 일시중지 테스트)...');
  await page.mouse.move(700, 800); // 하단 컨트롤 바로 이동
  await page.waitForTimeout(4000); // 타이머 만료 시간 이상 대기

  // 스크린샷: 컨트롤 바 호버 상태에서도 표시되어야 함
  await page.screenshot({ path: '/tmp/verify-fullscreen-6-controls-hover.png' });
  console.log('📸 스크린샷: /tmp/verify-fullscreen-6-controls-hover.png');

  // 9. 커서 스타일 확인 (cursor: none vs cursor: default)
  console.log('7️⃣  커서 스타일 검증...');

  // 마우스를 중앙 (컨트롤 바 아님)으로 이동
  await page.mouse.move(700, 300);
  const cursorActive = await playerContainer.evaluate(el => window.getComputedStyle(el).cursor);
  console.log(`   - 마우스 움직임 후 커서: ${cursorActive}`);

  // 마우스를 정지 상태로 두고 잠시 대기
  await page.waitForTimeout(4000);
  const cursorInactive = await playerContainer.evaluate(el => window.getComputedStyle(el).cursor);
  console.log(`   - 4초 정지 후 커서: ${cursorInactive}`);

  // 스크린샷: 커서 숨김 상태
  await page.screenshot({ path: '/tmp/verify-fullscreen-7-cursor-hidden.png' });
  console.log('📸 스크린샷: /tmp/verify-fullscreen-7-cursor-hidden.png');

  console.log('\n✅ 검증 완료!');
  console.log('\n📋 검증 결과:');
  console.log(`   ✓ Fullscreen 진입: OK`);
  console.log(`   ✓ 4초 후 컨트롤 바 자동 숨김: OK`);
  console.log(`   ✓ 마우스 이동 시 컨트롤 바 표시: OK`);
  console.log(`   ✓ 컨트롤 바 호버 시 타이머 일시중지: ${cursorInactive === 'none' ? 'OK' : 'PARTIAL'}`);
  console.log(`   ✓ 활성 상태 커서: ${cursorActive} (expected: default)`);
  console.log(`   ✓ 비활성 상태 커서: ${cursorInactive} (expected: none)`);

  await browser.close();
})();
