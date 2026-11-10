# kitsbase

팀이 함께 쓰는 사업 캘린더입니다. Claude 계정 없이, 링크에서 바로 가입하고 각자 이름과 비밀번호로 로그인해서 씁니다. 가입 인원은 `MAX_MEMBERS`(기본 4명)까지입니다.

## 기능

- **캘린더**: 일정·아이디어·미션·결정을 사업과 연결해 기록. 월·주·목록 보기, 사업별 필터와 컬러
- **작전실**: 사업이 궤도를 돌며 하나씩 나타나는 화면, 건설 현황 보기, 아래에 사업 요약 표
- **마인드맵**: 사업별 도형·이미지·연결선 편집, 정렬, 실행 취소, 단축키, 자동 저장
- **메모장**: 사업별 폴더, 서식 편집기, 카드 컬러
- **팀 메모**: 팀원끼리 1:1 또는 전체에게 메모, 읽음 표시, 알림
- 검색, 다가오는 7일 일정 알림, 휴대폰 화면, 다크 모드

입력한 내용은 서버(Cloudflare D1)에 저장되고, 열려 있는 다른 팀원 화면에 4초 안에 반영됩니다.

## 구조

| 경로 | 내용 |
| --- | --- |
| `public/index.html` | 화면 전체 (HTML 한 파일, 배포 시 Worker 코드에 함께 묶임) |
| `src/worker.js` | 가입·로그인·데이터 저장 API (Cloudflare Worker) |
| `migrations/` | 데이터베이스 테이블 |
| `wrangler.jsonc` | Cloudflare 설정 |

## 처음 배포하기

Node.js 22 이상과 Cloudflare 계정(무료)이 필요합니다.

```bash
npm install
npx wrangler login
```

현재 저장소는 이미 `kitsbase-db`에 연결되어 있습니다. 다른 Cloudflare 계정에 새로 배포할 때만, 데이터베이스를 만들고 출력되는 `database_id`를 `wrangler.jsonc`의 `database_id` 자리에 붙여넣습니다.

```bash
npx wrangler d1 create kitsbase-db
```

테이블을 만듭니다.

```bash
npm run db:migrate
```

비밀값 하나를 등록합니다. 명령을 실행하면 값을 입력하라고 나옵니다.

- `SESSION_SECRET`: 로그인 유지용 비밀값. 아무도 알 필요 없는 32자 이상의 무작위 문자열

```bash
npx wrangler secret put SESSION_SECRET
```

배포합니다. 끝나면 `https://kitsbase.<계정이름>.workers.dev` 주소가 나옵니다.

```bash
npm run deploy
```

이 주소를 팀원에게 전달하면, 각자 **처음 가입**에서 이름과 비밀번호를 정해 들어옵니다.

## 운영

- **인원 제한**: `wrangler.jsonc`의 `MAX_MEMBERS` (기본 4명, `0`이면 제한 없음). 바꾼 뒤 `npm run deploy`.
- **모두 로그아웃시키기**: `SESSION_SECRET`을 새 값으로 바꿉니다.
- **비밀번호를 잊은 팀원**: 그 사람의 계정을 지우면 같은 이름으로 다시 가입할 수 있습니다. 그동안 쓴 일정·메모 등은 그대로 남습니다.

```bash
npx wrangler d1 execute kitsbase-db --remote --command "DELETE FROM users WHERE name = '이름'"
```

## 로컬에서 실행

`.dev.vars` 파일을 만들고 아래처럼 적습니다.

```
SESSION_SECRET=local-dev-secret-0123456789abcdef
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

브라우저에서 `http://localhost:8787`을 엽니다.
