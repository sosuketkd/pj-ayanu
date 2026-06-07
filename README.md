# 綾整(Ayanu)

デイリータスク & AfterCheck 管理アプリ。アカウントでログインし、ワークスペース・タスク・AfterCheck を
端末をまたいで同期できます。

- フロント: `public/`（`index.html` + `styles.css` + `app.js`、バニラJS・ビルド工程なし）
- API: [Hono](https://hono.dev/) + **TypeScript** on Vercel（エントリ `api/`、実装 `src/`。ローカルは `tsx`、本番は Vercel が自動コンパイル）
- DB: [Neon](https://neon.tech/)（サーバーレス Postgres）
- 認証: メール / パスワード（パスワードは bcrypt でハッシュ化、JWT を httpOnly Cookie で保持）

## 共有・ワークスペース（GitHub / Notion 型）

- ワークスペースは **個人用 / チーム用** を作成でき、メンバーを招待して共有できます。
- 参加方法は2通り：**メール招待**（`notify@ayanu.sixma.jp` から招待メールを自動送信）と **招待リンク**。
- ロール: **オーナー / 管理者 / メンバー**。招待・削除・ワークスペース削除は権限で制御。
- 各ワークスペースは独立した日報（TDページ）＋ AfterCheck を持ち、メンバー全員で同期されます。
- 招待/参加は URL パラメータ `?invite=<token>` / `?join=<token>` で処理されます。

## 1. セットアップ

```bash
npm install
cp .env.example .env        # DATABASE_URL と JWT_SECRET を記入
```

- `DATABASE_URL` … Neon のダッシュボードで作成した DB の接続文字列（`?sslmode=require` 付き）
- `JWT_SECRET` … 長いランダム文字列（例: `openssl rand -base64 32`）
- `RESEND_API_KEY` … [Resend](https://resend.com) の API キー（招待メール送信用。未設定なら招待はリンク表示にフォールバック）
- `EMAIL_FROM` … 送信元（既定 `綾整(Ayanu) <notify@ayanu.sixma.jp>`）
- `APP_URL` … 公開URL（メール内リンク生成に使用。例 `https://ayanu.sixma.jp`）

### メール送信（Resend）のセットアップ

1. Resend で送信元ドメイン **`ayanu.sixma.jp`** を追加し、表示される **DNS レコード（SPF / DKIM）** を
   `sixma.jp` の DNS に登録して認証する。
2. API キーを発行し、`RESEND_API_KEY` に設定する。
3. これで `notify@ayanu.sixma.jp` から招待メールが送信されます。
   （ドメイン未認証だと送信は失敗し、自動的にリンク表示へフォールバックします）

### DB のテーブルを作成

```bash
npm run db:setup     # テーブル作成 / カラム追加（冪等。.env を自動読込）
npm run db:migrate   # v1 の既存データを共有モデルへ移行（任意・冪等）
```

> 各スクリプトは `.env`（`DATABASE_URL`）を自動で読み込みます（`--env-file-if-exists`）。

> `db:migrate` は旧 `app_state`（1ユーザー=1ブロック）に入っていたデータを、
> 各ユーザーが所有する個人ワークスペースへ展開します。既に移行済みのユーザーはスキップされます。

## 2. ローカルで動かす

```bash
npm run dev      # http://localhost:3000
```

`public/index.html` と API が同じオリジンで配信されます。サインアップ → ログインして動作確認できます。

## 3. Vercel に公開

```bash
npm i -g vercel   # 未インストールなら
vercel            # 初回はプロジェクトを作成・リンク
```

Vercel のプロジェクト設定 → **Environment Variables** に以下を登録してから本番反映：

| Name | Value |
|------|-------|
| `DATABASE_URL` | Neon の接続文字列 |
| `JWT_SECRET`   | 長いランダム文字列 |

```bash
vercel --prod
```

> Neon と Vercel は連携(Integration)もあります。Vercel の Storage から Neon を接続すると
> `DATABASE_URL` が自動で入ります。

## データ構造

- `users` … アカウント（メール / 表示名 `username` / 公開ユーザーID `handle`〔設定後不変〕 / 通知設定 `notifications`）
- `workspaces` … 共有可能なコンテナ（個人/チーム、招待リンク token を保持）
- `workspace_members` … 誰がどのワークスペースに、どのロールで所属するか
- `workspace_data` … そのワークスペースの日報＋AfterCheck（JSONB）
- `invitations` … メール招待（single-use）
- `app_state` … v1 の名残（移行元としてのみ保持）

各ワークスペースの中身は `workspace_data.data`(JSONB) にまとめて保存。将来タスク単位で
検索・共有したくなったら正規化（tickets / tasks テーブル）に移行できます。

## API

| Method | Path | 説明 |
|--------|------|------|
| POST | `/api/auth/signup` / `login` / `logout` | 認証 |
| GET  | `/api/auth/me` | ログイン中ユーザー |
| GET/PATCH | `/api/account` | アカウント設定（メール / 表示名 / ユーザーID / 通知設定）の取得・更新 |
| GET  | `/api/workspaces` | 自分のワークスペース一覧＋保留中の招待 |
| POST | `/api/workspaces` | 作成（`{name, kind}`、作成者がオーナー） |
| GET/PATCH/DELETE | `/api/workspaces/:id` | 詳細（メンバー等）/ 改名 / 削除 |
| GET/PUT | `/api/workspaces/:id/data` | 日報＋AfterCheck の取得 / 保存 |
| PATCH/DELETE | `/api/workspaces/:id/members/:userId` | ロール変更 / 削除・退出 |
| POST/DELETE | `/api/workspaces/:id/invites[/:inviteId]` | メール招待 作成 / 取消 |
| POST | `/api/invites/:token/accept` / `decline` | 招待の承諾 / 辞退 |
| POST/DELETE | `/api/workspaces/:id/invite-link` | 招待リンク 発行 / 無効化 |
| GET/POST | `/api/join/:token` | 招待リンクの確認 / 参加 |
