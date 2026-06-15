# 배포 가이드 (GitHub → Vercel 자동배포)

코드는 이미 git 커밋까지 완료되어 이 폴더에 준비되어 있습니다. 아래 순서만 따라하면 됩니다.

## 1. GitHub 저장소 만들기
1. https://github.com/new 접속 (로그인 필요)
2. Repository name: `ai-workshop-staff` (원하는 이름으로 변경 가능)
3. Public/Private 중 선택 (Private 추천)
4. "Create repository" 클릭 — README 등 추가 옵션은 모두 체크 해제

## 2. 코드 푸시
터미널 앱을 열고 아래 명령어를 순서대로 입력하세요. (이 폴더로 자동 이동)

```bash
cd "/Users/joonhochoi/Documents/Claude/Projects/워크샵 ai staff/ai-workshop-staff"
git branch -M main
git remote add origin https://github.com/<본인계정>/ai-workshop-staff.git
git push -u origin main
```

`<본인계정>` 부분은 본인 GitHub 사용자명으로 바꿔주세요. GitHub 로그인 창이 뜨면 로그인하세요.

## 3. Vercel에서 프로젝트 가져오기
1. https://vercel.com/new 접속
2. "Import Git Repository"에서 방금 만든 `ai-workshop-staff` 선택
3. Framework Preset: Other (자동 감지됨, 변경 불필요)

## 4. 환경변수 설정 (배포 전 필수!)
"Environment Variables" 섹션에 아래 2개를 추가:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | `https://qzahgprzisunuievkmka.supabase.co` |
| `SUPABASE_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF6YWhncHJ6aXN1bnVpZXZrbWthIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyMzEyMzIsImV4cCI6MjA5MjgwNzIzMn0.zrdborscUIHIwS6O0sMWKDu3SJtIzhyxQ2z36Oey_N4` |

## 5. Deploy 클릭
배포 완료 후 발급되는 URL(예: `https://ai-workshop-staff.vercel.app`)로 접속해 확인합니다.

- 관리자 페이지: `<배포URL>/admin.html` (비밀번호: admin1234)
- 참여자 페이지: `<배포URL>/index.html`

## 6. 이후 업데이트 방법
코드를 수정한 뒤 다시 배포하려면:
```bash
cd "/Users/joonhochoi/Documents/Claude/Projects/워크샵 ai staff/ai-workshop-staff"
git add -A
git commit -m "업데이트 내용"
git push
```
GitHub에 push하면 Vercel이 자동으로 재배포합니다.
