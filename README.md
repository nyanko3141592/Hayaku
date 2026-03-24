# Hayaku Translate ⚡

Gemini API搭載の爆速翻訳 Chrome拡張。速度にこだわり、コストより高速を重視した設計。

## 特徴

- **爆速翻訳** — Gemini 3.1 Flash Lite (382 tok/s) をデフォルト使用
- **ストリーミング表示** — 最初のトークンが来た瞬間から表示開始
- **2層キャッシュ** — インメモリ L1 + IndexedDB L2 でキャッシュヒット時 ~0ms
- **並列ページ翻訳** — 4並列バッチで全ページを高速翻訳
- **スマートモデル選択** — テキスト長に応じて最適なモデルを自動選択
- **返信作成** — 翻訳結果から直接、元の言語で返信を生成
- **選択テキスト置換** — 入力欄の選択テキストを翻訳で直接置き換え
- **AI Gateway対応** — Cloudflare AI Gateway 経由でモニタリング・レート制限が可能
- **デュアルモード** — 個人利用(APIキー直接) / チーム配布(Google認証+Worker)

## 高速化アーキテクチャ

```
テキスト選択 → リクエスト即時発火（UI構築と並行）
                  ↓
            L1 メモリキャッシュ (Map, LRU, ~0ms)
                  ↓ miss
            L2 IndexedDB キャッシュ (7日/500件)
                  ↓ miss
            スマートモデル選択 (短文→flash-lite, 長文→flash)
                  ↓
            Adaptive maxOutputTokens (短文は512, 長文は8192)
                  ↓
            SSE ストリーミング → スケルトン → 逐次表示
                  ↓
            プリフライト ウォームアップ (10分間隔)
            リクエスト デデュプリケーション
            設定キャッシュ (5秒TTL)
```

## セットアップ

### 1. Gemini APIキーの取得

[Google AI Studio](https://aistudio.google.com/apikey) でAPIキーを取得。

### 2. Chrome拡張のインストール

```bash
git clone https://github.com/nyanko3141592/Hayaku.git
```

1. Chrome で `chrome://extensions` を開く
2. 「デベロッパーモード」を有効化
3. 「パッケージ化されていない拡張機能を読み込む」でクローンしたフォルダを選択
4. ポップアップでAPIキーを設定

### 3. (オプション) AI Gateway

[Cloudflare AI Gateway](https://dash.cloudflare.com/) でゲートウェイを作成し、URLをポップアップの設定欄に入力。

```
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_name}
```

### 4. (オプション) チーム配布モード

Cloudflare Worker をデプロイして、Google OAuth認証経由でチームメンバーにAPIキーなしで使ってもらう構成。

```bash
cd worker
pnpm install
wrangler secret put GEMINI_API_KEY    # APIキーをシークレットに設定
wrangler deploy
```

`wrangler.toml` で以下を設定:

| 変数 | 説明 |
|------|------|
| `ALLOWED_DOMAINS` | 許可するGoogleドメイン（例: `example.com`） |
| `AI_GATEWAY_URL` | Cloudflare AI Gateway URL（任意） |

ポップアップの「Worker URL」にデプロイしたWorkerのURLを入力。

## 使い方

| 操作 | 説明 |
|------|------|
| テキスト選択 → ミニボタン | 選択テキストを翻訳 |
| `Alt+T` | 選択テキストを翻訳 |
| `Alt+Shift+T` | ページ全体を翻訳 |
| 右クリック → Hayaku翻訳 | コンテキストメニューから翻訳 |
| ポップアップ | クイック翻訳 + 設定 |
| フルページ | 大規模テキスト翻訳 + 返信作成 |

## 対応モデル

| モデル | 特徴 |
|--------|------|
| `gemini-3.1-flash-lite-preview` | **デフォルト・最速** (382 tok/s) |
| `gemini-2.5-flash-lite` | 高速・安定 |
| `gemini-2.5-flash` | バランス（長文用に自動選択） |
| `gemini-3-flash-preview` | 高品質・高速 |
| `gemini-3.1-pro-preview` | 最高品質 |

## 対応言語

日本語, English, 中文, 한국어, Español, Français, Deutsch, Português, Русский, العربية, हिन्दी, Italiano

## ライセンス

MIT
