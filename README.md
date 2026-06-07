# 綾整(Ayanu)

デイリータスク & AfterCheck 管理アプリ。アカウントでログインし、ワークスペース・タスク・AfterCheck を
端末をまたいで同期できます。

- フロント: `index.html`（単一ファイル）
- API: [Hono](https://hono.dev/) on Vercel（`api/`, `lib/`）
- DB: [Neon](https://neon.tech/)（サーバーレス Postgres）
- 認証: メール / パスワード（パスワードは bcrypt でハッシュ化、JWT を httpOnly Cookie で保持）

## 1. セットアップ

```bash
npm install
cp .env.example .env        # DATABASE_URL と JWT_SECRET を記入
```

- `DATABASE_URL` … Neon のダッシュボードで作成した DB の接続文字列（`?sslmode=require` 付き）
- `JWT_SECRET` … 長いランダム文字列（例: `openssl rand -base64 32`）

### DB のテーブルを作成

```bash
export $(grep -v '^#' .env | xargs)   # .env を読み込む（zsh/bash）
npm run db:setup
```

## 2. ローカルで動かす

```bash
npm run dev      # http://localhost:3000
```

`index.html` と API が同じオリジンで配信されます。サインアップ → ログインして動作確認できます。

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

## データ構造（v1）

ユーザーごとに、フロントの状態（`store`）をまるごと `app_state.data`(JSONB) に保存しています。
シンプルさ優先の設計です。将来タスク単位で検索・共有したくなったら正規化（tickets / tasks テーブル）に
移行できます。

## API

| Method | Path | 説明 |
|--------|------|------|
| POST | `/api/auth/signup` | 新規登録（`{email, password}`） |
| POST | `/api/auth/login`  | ログイン |
| POST | `/api/auth/logout` | ログアウト |
| GET  | `/api/auth/me`     | ログイン中ユーザー |
| GET  | `/api/state`       | 自分の状態を取得 |
| PUT  | `/api/state`       | 自分の状態を保存（`{data}`） |
