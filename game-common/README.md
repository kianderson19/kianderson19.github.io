# game-common · 난이도 디렉터

앞으로 만들 게임에 공통으로 붙이는 **난이도 디렉터** 모듈입니다.
참고 영상(Block Blast 코드 분석 쇼츠)에서 설명한 구조를 최대한 그대로 옮겼어요.
"이 플레이어가 광고로 얼마나 가치 있는지"를 계산하고, 그에 맞춰 판마다 쉽게 해줄지(boost),
그냥 둘지(normal), 끝내버릴지(kill)를 정합니다.

- 의존성 없는 순수 JavaScript(ES 모듈)라서 웹, WebView, Cocos/Phaser 같은 JS 엔진에서 바로 쓸 수 있어요.
- 게임별로 할 일은 **"이 블록(카드, 적…)이 플레이어에게 얼마나 유리한가"를 숫자로 알려주는 함수 하나**뿐이에요.
- 데모: `demo/index.html` (8×8 블록 퍼즐 + 디렉터 상태 패널)

## 영상 장면 → 구현

| 영상에서 말한 것 | 구현 |
|---|---|
| "국가, 지난 광고 수익, 폰, 소리를 켰는지까지 전부 들어간다" | `value.js` `estimateValue()`: 국가 등급, 기기 등급, 배경음, 진동, 광고 수익(최근·최대·7일 평균), 광고 시청 습관을 0~1 점수로 계산 |
| "폰에서 로컬로 돌아가는 코드" | 전부 기기 안에서 계산하고, 기록은 `storage`에 저장 (서버 없음) |
| "boost then kill": 평균 게임 길이까지는 인생 최고의 판 | `boostThenKill`: 진행도(이번 판 길이 ÷ 평균 길이)가 15%를 넘으면 boost, 85%부터 normal, 100%에서 kill. 가치가 높은 플레이어일수록 kill이 일찍 와요 (`valueShift`) |
| "비싼 광고가 준비되면 돌변한다", "광고를 본 이력이 있는지 확인" | `highValueAdHarvest`: 준비된 광고 단가가 `minAdValue` 이상이고 광고 시청 이력이 있으면 kill |
| "최고 기록을 깨기 직전 death algorithm" | `highScoreGuard`: 최고 기록의 90%를 넘으면 kill. 가끔(`beatChance`)만 경신을 허용 |
| "몰래 최고 기록 근처까지 데려가서 계속 오게 만든다" | `nearHighScoreTease`: 최고 기록의 55~90% 구간에서 boost → 아슬아슬하게 실패 |
| "정확히 몇 분째에 지게 만든다" | `exactMinuteKill`: 3·5·8·12분째에 한 번씩 확률을 굴려서 걸리면 그 판은 kill |
| "다음 턴에 살아남을 블록을 안 준다", "No Space Left" | `pick()`: 후보를 유리한 순서로 정렬해서 boost면 유리한 쪽, kill이면 놓을 자리가 없는 쪽에서 뽑음 |
| "지는 순간 리바이브 제안", "어떤 제안에 광고를 보는지" | `gameOver()` → `reviveResult()`: 리바이브 제안 4가지 방식을 다 써보고, 이 플레이어가 가장 잘 보는 방식을 학습 |
| 리바이브 후 | `reviveGrace`: 몇 수 동안 boost해서 광고 본 보람을 준 뒤, 다시 boost then kill로 복귀 |
| (추가) 신규 유저 | `newPlayerHoneymoon`: 처음 2판은 후하게 |

규칙마다 우선순위가 있어서 여러 규칙이 동시에 의견을 내면 우선순위가 높은 쪽이 이겨요.
기본값: 리바이브 직후(50) > 신규 유저(45) > 최고 기록 가드(40) > 광고 수확(30) > 정각 kill(25) > 기록 근처 boost(20) > boost then kill(10).

## 파일

```
game-common/
  src/
    index.js      내보내기 모음
    director.js   createDirector(): 메인 API
    config.js     기본값, 프리셋(harvest / fair), mergeConfig()
    rules.js      규칙들 (위 표)
    value.js      플레이어 가치 계산
    profile.js    판 기록, 최고 기록, 광고 이력 (저장 대상)
    storage.js    memoryStorage, localStorageStorage
  demo/           브라우저 데모
  test/           node --test 테스트
```

## 붙이는 법

```js
import { createDirector, presets, localStorageStorage } from './game-common/src/index.js';

const director = createDirector({
  config: presets.harvest,                       // 또는 presets.fair, 또는 일부만 덮어쓰기
  storage: localStorageStorage('my-game'),
  signals: {
    country: 'KR',                               // 기기 지역
    model: 'iPhone17,2',                         // 기기 모델 식별자
    bgmOn: settings.music,
    vibrationOn: settings.vibration,
  },
  ads: {
    isReady: (format) => adSdk.isReady(format),  // 'rewarded' | 'interstitial'
    readyAdValue: () => adSdk.loadedAdRevenue(), // 지금 로드된 광고의 예상 수익(USD)
  },
});

// 1) 판 시작
director.startRun();

// 2) 블록/카드/적을 고를 때: "플레이어에게 유리할수록 큰 숫자"를 주는 함수만 넘기면 됨
const piece = director.pick(ALL_PIECES, (p) => howHelpful(board, p));

// 3) 매 수(턴)마다
const decision = director.turn({ score });
// decision.mode: 'boost' | 'normal' | 'kill'
// decision.difficulty: 0(가장 유리) ~ 1(가장 불리)
// decision.rule / decision.reason: 어떤 규칙이 왜 이겼는지

// 4) 광고 SDK의 노출 수익 콜백(ILRD)에서
director.onAdShown({ format: 'interstitial', revenue: 0.012 });

// 5) 더 둘 곳이 없을 때
const offer = director.gameOver();
if (offer.offer) {
  // offer.variant: 'countdown5' | 'countdown10' | 'nearBest' | 'progress'
  // offer.toBest: 최고 기록까지 남은 점수 (nearBest 화면에 표시)
  const watched = await showReviveOffer(offer);
  director.reviveResult(watched);                // 봤으면 이어하기, 아니면 끝
}

// 6) 판 끝
const result = director.endRun({ score });       // { newBest, highScore, length, ... }
```

`helpfulness` 예시:

- 블록 퍼즐: 놓을 자리가 없으면 아주 낮게, 줄을 지울 수 있으면 높게
- 카드 게임: 지금 손패와 합쳐서 이길 확률이 올라가는 카드일수록 높게
- 액션/러너: 플레이어가 쉽게 잡는 적, 피하기 쉬운 장애물일수록 높게

`pick()`을 쓰지 않는 게임은 `decision.difficulty`(0~1)를 직접 받아서 적 체력, 속도, 드롭률 같은 데에 쓰면 돼요.

## 설정 바꾸기

`createDirector({ config: { ... } })`에 넣은 값은 기본값 위에 덮어써져요. 원격 설정(JSON)으로 받아서 넣어도 돼요.

```js
createDirector({
  config: {
    lengthUnit: 'ms',                            // 게임 길이를 '수' 대신 '시간'으로
    rules: {
      boostThenKill: { killFrom: 1.1 },          // 평균보다 10% 더 길게 봐줌
      exactMinuteKill: { enabled: false },       // 이 규칙 끄기
      highScoreGuard: { beatChance: 0.35 },      // 기록 경신을 더 자주 허용
    },
    value: { countryTiers: { VN: 2 } },          // 국가 등급 조정
  },
});
```

게임 전용 규칙도 추가할 수 있어요.

```js
createDirector({
  rules: {
    bossFloor: ({ run }) => (run.turns % 10 === 0 ? { mode: 'kill', reason: '보스 층' } : null),
  },
  config: { rules: { bossFloor: { enabled: true, priority: 35 } } },
});
```

### 프리셋

- `presets.harvest`: 영상과 같은 방식 (기본값)
- `presets.fair`: 같은 구조에서 가치·광고·최고 기록 기반 kill을 모두 끄고 실력만 반영. 짧게 끝난 판 다음에만 살짝 쉽게 해줘요. 리바이브 광고는 그대로 둬요.

## 데모 · 테스트

```sh
# 저장소 루트에서
python3 -m http.server 8000
# 브라우저: http://localhost:8000/game-common/demo/

cd game-common && npm test
```

main에 머지되면 GitHub Pages에서 `https://kianderson19.github.io/game-common/demo/`로 열려요.
johap.lol(Cloudflare) 배포 목록에는 들어가지 않아요.

데모 오른쪽 패널에서 국가·기기·배경음·광고 가격을 바꾸면 플레이어 가치와 모드가 바로 바뀌어요.
"판단 기록"에서 어느 수에 어떤 규칙이 이겼는지 볼 수 있어요.

## 다른 엔진으로 옮길 때

로직은 입력(신호, 판 상태, 광고 상태)과 출력(mode, difficulty) 사이의 순수 계산이라 Swift나 C#으로 그대로 옮길 수 있어요.
옮길 때는 `rules.js`, `value.js`, `director.js`의 `pick()`만 맞추고, `config.js`는 JSON으로 빼서 같은 값을 쓰면 돼요.
`test/director.test.js`의 시나리오를 그 언어의 테스트로 옮기면 동작이 같은지 확인할 수 있어요.

## 출시 전에 확인할 것

- **개인정보처리방침과 App Store 개인정보 라벨**: 지금 FOUR 방침에는 "광고·분석·추적 없음, 수집 없음"이라고 되어 있어요.
  이 모듈과 광고 SDK를 붙이면 기기 모델, 지역, 광고 이력을 쓰게 되니 방침과 라벨을 먼저 고쳐야 해요.
- **광고 SDK 동의**: 국가별 동의 팝업(GDPR 등)과 iOS 추적 허용(ATT)은 광고 SDK 쪽 설정을 따르세요.
- 이 방식은 영상처럼 코드가 분석되면 "조작"으로 알려질 수 있어요. 게임마다 `harvest`와 `fair` 중 어느 쪽을 쓸지 정하고,
  규칙은 하나씩 켜고 끌 수 있어요.
