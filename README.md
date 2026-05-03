# Sky Star Cluster

Bluesky 日本語圏のユーザーネットワークを可視化する Web アプリケーション。
AT Protocol でフォロー関係を取得し、Sigma.js でインタラクティブなグラフとして表示する。

**URL:** https://skystarcluster.social

---

## 機能

- ハッシュタグコミュニティのネットワークグラフ表示
- ユーザー影響力ランキング（独自スコアリング）
- ハッシュタグランキング（ノード数順、HOT バッジ表示）
- ノード検索・フィルタリング
- ユーザー詳細パネル（フォロー数、投稿数、おすすめユーザー）
- OGP 画像自動生成・SNS シェア
- Bluesky / X への投稿ボタン

---

## アーキテクチャ

```
EventBridge (1H間隔)
      ↓
Lambda (Scheduler)
      ↓ (非同期 Invoke × カテゴリ数)
Lambda (Graph Crawler)
  ├─→ AT Protocol で投稿検索・DID 抽出
  ├─→ プロフィール取得
  ├─→ フォロー関係構築
  ├─→ ランキング計算
  └─→ グラフ JSON 生成 → S3
      ↓
CloudFront (skystarcluster.social)
  ├─→ S3 Frontend (Vite + React + Sigma.js)
  └─→ S3 Graph Data (/sigma-graph/*)

Lambda (OGP Image API)
  └─→ Playwright でシェアカード画像生成 → S3

Lambda (Graph API)
  └─→ TOP ポスト取得 (AT Protocol)

CloudFront Functions
  └─→ OGP HTML Injector (viewer-request)
```

---

## プロジェクト構成

```
bluesky-sigma-showcase/
├── frontend/                     # React + Vite + Sigma.js
│   ├── src/
│   │   ├── App.jsx              # メインアプリケーション
│   │   ├── style.css            # スタイル
│   │   └── main.jsx             # エントリポイント
│   └── public/                  # 静的アセット (favicon, ロゴ)
├── lambda/
│   └── handlers/
│       ├── scheduler/           # 定期実行スケジューラ
│       ├── graph_crawler/       # グラフクロール・集計
│       ├── graph_api/           # API エンドポイント
│       ├── ogp_image_api/       # OGP 画像生成 (Playwright)
│       └── top_post_api/        # TOP ポスト取得
├── cdk/                         # AWS CDK (TypeScript)
│   └── lib/
│       ├── bluesky_sigma_stack.ts
│       └── index.ts
└── data/
    └── stable_hashtags.json
```

---

## セットアップ

### 前提条件
- AWS アカウント (ap-northeast-1)
- AWS CLI 設定済み
- Node.js 18+
- Python 3.12+

### フロントエンド

```bash
cd frontend
npm install
npm run dev       # ローカル開発
npm run build     # 本番ビルド
```

### CDK デプロイ

```bash
cd cdk
npm install
npx cdk deploy
```

### フロントエンド デプロイ

```bash
cd frontend
npm run build
aws s3 sync dist/ s3://bluesky-sigma-frontend-878311109818/
aws cloudfront create-invalidation --distribution-id E3MYK1FTWW9VK --paths "/*"
```

---

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | React, Sigma.js, Graphology, Vite |
| バックエンド | Python 3.12, AT Protocol (atproto) |
| インフラ | AWS CDK (TypeScript) |
| コンピュート | Lambda (ARM64) |
| ストレージ | S3 |
| CDN | CloudFront + カスタムドメイン (ACM) |
| DNS | Route 53 |
| OGP 画像 | Playwright (Chromium), Lambda Container |
| スケジューラ | EventBridge |

---

## ライセンス

MIT License

---

## 参考

- [AT Protocol](https://atproto.com/)
- [Bluesky](https://bsky.app/)
- [Sigma.js](https://www.sigmajs.org/)
- [AWS CDK](https://aws.amazon.com/cdk/)
