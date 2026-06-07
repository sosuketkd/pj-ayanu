# 綾整(Ayanu) 仕様書

> デイリータスク & AfterCheck 管理アプリ。アカウントでログインし、ワークスペース単位で
> 日報（チケット）・タスク・AfterCheck を端末をまたいで同期・共有する。
> 本書はソースコードから起こした現状ベースの仕様書（2026-06時点）。

---

## 1. 概要

- **目的**: その日の日付ごとに「チケット（1日分のシート）」を作り、その中で階層タスクを管理する。
  併せて、日付に依存しない「AfterCheck（毎日共通のチェック項目）」を管理する。
- **利用形態**: Web アプリ。メール/パスワードでログインし、データはサーバー（Neon Postgres）に同期される。
- **共有**: GitHub / Notion 型のワークスペース共有。個人用/チーム用ワークスペースを作り、
  メンバーを招待してロール（オーナー/管理者/メンバー）付きで共同編集できる。

---

## 2. 技術スタック・アーキテクチャ

| 層 | 採用技術 |
|----|----------|
| フロント | `public/`（`index.html` + `styles.css` + `app.js`、バニラ JS、ビルド工程なし） |
| API | [Hono](https://hono.dev/) 4.x（`src/app.js` がルートを束ね、`src/routes/*` に分割） |
| 実行環境 | Vercel（本番、`api/index.js`）/ ローカルは `@hono/node-server`（`src/server.js`） |
| DB | [Neon](https://neon.tech/) サーバーレス Postgres（`@neondatabase/serverless`） |
| 認証 | メール/パスワード。`bcryptjs` でハッシュ化、JWT（`hono/jwt`, HS256）を httpOnly Cookie に保持 |

**設計方針**: ビルド工程のないバニラJSフロントをほぼそのまま使うため、各ワークスペースの中身
（チケット群 + AfterCheck）を 1 つの JSONB（`workspace_data.data`）として丸ごと保存する
「JSON ブロブ / ワークスペース」方式。タスク単位の検索・共有が必要になったら正規化（tickets/tasks テーブル）へ移行する想定。

### リクエストの流れ
```
ブラウザ (public/index.html)
  └─ fetch("/api/...") credentials:include
       ├─ ローカル: src/server.js が静的配信 + Hono API を同一オリジンで提供
       └─ 本番:    Vercel が public/ を静的配信、/api/* を api/index.js → Hono へ
            └─ src/app.js (Hono) ─ src/routes/* ─ src/lib/db.js (Neon sql) ─ Neon Postgres
```

---

## 3. ディレクトリ構成

```
ayanu/
├── public/
│   ├── index.html          画面のマークアップ
│   ├── styles.css          スタイル
│   └── app.js              フロントのロジック（バニラ JS）
├── api/index.js            Vercel 用ハンドラ。Hono app を Node (req,res) にブリッジ
├── src/
│   ├── server.js           ローカル開発サーバー（静的配信 + API、ポート3000）
│   ├── app.js              Hono アプリ本体。ルートを束ねる
│   ├── middleware/
│   │   └── auth.js         requireUser（ログイン必須ゲート）/ setAuthCookie
│   ├── routes/
│   │   ├── auth.js         signup / login / logout / me
│   │   ├── workspaces.js   ワークスペース CRUD + 内容（日報＋AfterCheck）
│   │   ├── members.js      メンバーのロール変更 / 削除・退出
│   │   └── invites.js      メール招待 / 招待リンク / 参加
│   ├── lib/
│   │   ├── auth.js         パスワードハッシュ / JWT 発行・検証 / Cookie 寿命
│   │   ├── db.js           Neon sql クライアント（テスト時は pg にフォールバック）
│   │   └── email.js        招待メール送信（Resend HTTP API）
│   └── utils.js            共通ヘルパ（atLeast / validEmail / membership / baseUrl）
├── db/
│   └── schema.sql          DB スキーマ（DDL）
├── scripts/
│   ├── setup-db.js         schema.sql を流してテーブル作成（npm run db:setup）
│   └── migrate-v2.js       v1 の app_state を v2 ワークスペースへ移行（冪等、npm run db:migrate）
├── docs/
│   ├── SPEC.md             本書（現状仕様）
│   ├── note.txt            旧・簡易仕様メモ（※現状とずれあり。9.1 参照）
│   └── todo.txt            未実装の要望リスト（9.2 参照）
└── .env / .env.example     DATABASE_URL, JWT_SECRET ほか
```

---

## 4. データモデル

### 4.1 DB テーブル（`db/schema.sql`）

| テーブル | 役割 | 主なカラム |
|----------|------|-----------|
| `users` | アカウント | `id(uuid)`, `email(unique)`, `password_hash`, `created_at` |
| `workspaces` | 共有可能なコンテナ | `id`, `name`, `kind('personal'\|'team')`, `created_by`, `invite_token(unique, null=無効)`, `invite_role` |
| `workspace_members` | 所属とロール | PK=`(workspace_id, user_id)`, `role('owner'\|'admin'\|'member')`, `joined_at` |
| `workspace_data` | ワークスペースの中身 | PK=`workspace_id`, `data(jsonb)`, `updated_at` |
| `invitations` | メール招待（単回使用） | `id`, `workspace_id`, `email`, `role`, `token(unique)`, `invited_by`, `accepted_at` |
| `app_state` | **v1 の名残**（移行元としてのみ保持） | PK=`user_id`, `data(jsonb)` |

- `pgcrypto` 拡張（`gen_random_uuid()`）を使用。
- 外部キーは概ね `on delete cascade`（workspace 削除でメンバー/データ/招待も消える）。

### 4.2 ワークスペース中身の JSON 形（`workspace_data.data`）

フロントが PUT する `data` オブジェクトの形：

```jsonc
{
  "tickets": {
    "2026-06-07": {            // キーは日付 "YYYY-MM-DD"
      "tasks": [ /* Task[] */ ],
      "todos": [ /* ※ 現在は未使用（後述） */ ]
    }
  },
  "ac": [ /* AfterCheckItem[] : 全日付で共通 */ ]
}
```

**Task オブジェクト**（左「ToDo」パネル、階層タスク）:
```jsonc
{
  "id": "abc123",
  "text": "資料作成",
  "est": "1.5",               // 見積もり時間(h)、文字列
  "prio": "top",              // "top"(優) | "semi"(準)。既定は "top"
  "comment": "メモ・進捗",
  "showComment": false,        // コメント欄の開閉状態（UI状態も保存される）
  "done": false,
  "children": [ /* Task[] : ネストは1段のみ */ ],
  "showChildren": true         // 子追加時に付与
}
```

**AfterCheckItem オブジェクト**（右「AfterCheck」パネル、フラットなチェックリスト）:
```jsonc
{ "id": "xyz789", "text": "日報を提出", "done": false }
```

> **注意**: `ticket.todos` 配列は `ticket()` 生成時に作られるが、現行 UI ではレンダリングされない
> 旧フィールド（vestigial）。右パネルのチェックリストは `data.ac`（AfterCheck）を使う。

---

## 5. フロントエンド（画面・機能）

### 5.1 画面構成（ログイン後 `<main>`、3パネル）

1. **カレンダー** パネル — 月送りカレンダー + 入力のある日付一覧。日付を選んでチケットを切り替え。
2. **ToDo** パネル（旧称: 左側/詳細タスク） — 選択中の日付の階層タスクを管理。
3. **AfterCheck** パネル（旧称: 右側/シンプルToDo） — 「毎日共通」のフラットなチェックリスト（日付に依存しない）。

ヘッダーにワークスペース切替（ドロワー）、共有・メンバー設定、ユーザー情報/ログアウト、同期ステータス表示。

### 5.2 ToDo（階層タスク）機能

- **階層（親子）**: ネストは **1段のみ**。Tab=子化（インデント）/ Shift+Tab=親に戻す、ドラッグハンドル(`⠿`)を右に寄せても子化。`⇥`/`⇤` ボタンでも可。
- **見積もり時間**: 各タスクに数値入力（h）。サマリー集計あり。
- **2段階優先度**: `優(top)` ⇄ `準(semi)` をボタンでトグル。既定は `優`。
- **コメント**: `💬` で各タスクにメモ欄を開閉。
- **並び替え**: ドラッグ&ドロップで上下入れ替え。
- **完了チェック**: チェックで取り消し線。
- **入力**: テキストエリアで Shift+Enter=改行 / Enter=次の兄弟タスク追加。IME変換中の Enter/Tab は無視。

### 5.3 AfterCheck 機能

- フラットな1行リスト（階層・時間・優先度・コメントなし）。
- 完了チェックで取り消し線。Shift+Enter で改行可。
- **全日付で共通**（チケットごとではなくワークスペース単位で1つ）。

### 5.4 永続化（同期）

- 変更のたびに `save()` → `localStorage`（`ayanu.cache.v2:<wsId>`）にオフラインミラー + 600ms デバウンスで
  `PUT /api/workspaces/:id/data` にサーバー保存。
- ステータス表示: 「保存中… / 保存済み / 保存失敗」。失敗時は `dirty` を立て次回再送。
- ワークスペース切替時は `flushSave()` で保留中の保存を先に確定。

---

## 6. 認証・認可

- **トークン**: JWT（HS256）。ペイロード `{ sub: userId, email, exp }`、寿命 30日。httpOnly + Secure + SameSite=Lax Cookie `token`。
- **サインアップ**: メール形式チェック + パスワード 6文字以上。既存メールは 409。
- **ログイン**: bcrypt 照合。失敗は 401（メール/パスワードの区別はしない）。
- **`requireUser` ミドルウェア**: Cookie の JWT を検証し、`userId`/`email` をコンテキストに設定。無効なら 401。
- **ロール階層**: `member(1) < admin(2) < owner(3)`。`atLeast(role, min)` で判定。
- `JWT_SECRET` 未設定時は開発用の安全でない既定値にフォールバック（本番では必ず設定）。

### 共有モデル

- **ワークスペース種別**: `personal` / `team`。作成者が `owner`。
- **招待2方式**:
  1. **メール招待** (`invitations`): 招待されたメールでログインしたユーザーだけが承諾可能。単回使用。
  2. **招待リンク** (`workspaces.invite_token`): ログイン済みの誰でも `?join=<token>` で参加。発行/無効化可。
- **URL パラメータ**: `?invite=<token>`（メール招待）/ `?join=<token>`（招待リンク）をフロントが処理。
- **権限**: 招待発行・メンバー削除・改名は `admin` 以上、ワークスペース削除は `owner` のみ。
  オーナー譲渡は `owner` のみ可（譲渡すると自身は `admin` に降格）。オーナーは退出/削除不可（先に譲渡が必要）。

---

## 7. API リファレンス（`/api` 配下、すべて要ログイン以外は明記）

| Method | Path | 説明 | 認可 |
|--------|------|------|------|
| POST | `/auth/signup` | サインアップ（Cookie 発行） | 公開 |
| POST | `/auth/login` | ログイン | 公開 |
| POST | `/auth/logout` | ログアウト（Cookie 削除） | 公開 |
| GET | `/auth/me` | ログイン中ユーザー | 要ログイン |
| GET | `/workspaces` | 自分のWS一覧 + 保留中メール招待 | 要ログイン |
| POST | `/workspaces` | WS作成（`{name, kind}`、作成者=owner） | 要ログイン |
| GET | `/workspaces/:id` | 詳細（メンバー/自ロール/招待リンク/保留招待） | メンバー |
| PATCH | `/workspaces/:id` | 改名（`{name}`） | admin+ |
| DELETE | `/workspaces/:id` | 削除 | owner |
| GET | `/workspaces/:id/data` | 中身(JSON)取得 | メンバー |
| PUT | `/workspaces/:id/data` | 中身(JSON)保存（upsert） | メンバー |
| PATCH | `/workspaces/:id/members/:userId` | ロール変更（`{role}`） | admin+ |
| DELETE | `/workspaces/:id/members/:userId` | メンバー削除 / 自身の退出 | admin+ or 本人 |
| POST | `/workspaces/:id/invites` | メール招待作成（`{email, role}`） | admin+ |
| DELETE | `/workspaces/:id/invites/:inviteId` | メール招待取消 | admin+ |
| POST | `/invites/:token/accept` | メール招待を承諾（招待先メール本人のみ） | 要ログイン |
| POST | `/invites/:token/decline` | メール招待を辞退 | 要ログイン |
| POST | `/workspaces/:id/invite-link` | 招待リンク発行（`{role}`） | admin+ |
| DELETE | `/workspaces/:id/invite-link` | 招待リンク無効化 | admin+ |
| GET | `/join/:token` | 招待リンクのプレビュー | 要ログイン |
| POST | `/join/:token` | 招待リンクで参加 | 要ログイン |

エラーは `{ error: "日本語メッセージ" }` + 適切な HTTP ステータス（400/401/403/404/409）で返す。

---

## 8. セットアップ・実行・デプロイ

### ローカル
```bash
npm install
cp .env.example .env          # DATABASE_URL と JWT_SECRET を記入
export $(grep -v '^#' .env | xargs)
npm run db:setup              # テーブル作成
npm run db:migrate            # （任意）v1 データを移行・冪等
npm run dev                   # http://localhost:3000 （src/server.js、Vercel CLI 不要）
```

環境変数:
- `DATABASE_URL` … Neon 接続文字列（`?sslmode=require` 付き）
- `JWT_SECRET` … 長いランダム文字列（`openssl rand -base64 32`）
- `AYANU_PG_TEST` … セット時は Neon HTTP ドライバの代わりにローカル Postgres（`pg`）を使用（テスト用）

### Vercel 本番
```bash
vercel            # 初回リンク
# Project Settings → Environment Variables に DATABASE_URL / JWT_SECRET を登録
vercel --prod
```
`api/index.js` は Vercel の **Node.js ランタイム**で動作（bcryptjs のため）。
Vercel の Node ランタイムはリクエストボディを事前パースするため、`api/index.js` は
パース済みの `req.body` から Web `Request` を組み立てて Hono にブリッジしている。

---

## 9. 現状メモ・既知のギャップ

実装と古いドキュメントの差分、未対応の要望を引き継ぎのため明記する。

### 9.1 `note.txt`（旧・簡易仕様）とのずれ
- note.txt は「1チケット＝左右2分割（左=詳細タスク / 右=シンプルToDo）」と記述するが、
  **現状は3パネル（カレンダー / ToDo / AfterCheck）**。「右側のシンプルToDo」は
  **AfterCheck（毎日共通・日付非依存）** に役割が変わっている。note.txt は歴史的経緯の参考に留める。

### 9.2 `todo.txt` の未実装要望
- 機能: TD 一式のインポート/エクスポート、アカウント設定画面、ソーシャルログイン。
  （※レポーティング、ワークスペース名変更、レポートの CSV 出力は実装済み）
- UI（現状コードに未反映）:
  - 階層変更用の矢印（`⇥`/`⇤`）を廃止したい → **現状は残っている**。
  - 優先度「優」の色（青）を廃止し、代わりに「準」のタスクは行背景を薄いグレーにしたい → **未対応**。
  - 右上の日付選択を廃止したい。
  - ゴミ箱(`🗑`)ボタンを三点メニューにして「コピー / 削除」を選べるようにしたい → **現状は🗑のみ**。

### 9.3 その他
- `ticket.todos` は未使用フィールド（4.2 参照）。
- `app_state` テーブルは v1 移行元としてのみ存在。
- データは正規化されておらず、ワークスペース全体が 1 JSONB。タスク単位の検索・部分共有は不可。
- 保存は全体上書き（PUT）。同一ワークスペースを同時編集すると後勝ち（コンフリクト解決なし）。
