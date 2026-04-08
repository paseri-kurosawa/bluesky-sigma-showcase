# Bluesky Sigma Showcase

Bluesky 日本語圏のユーザーネットワークを AT Protocol で取得し、Sigma.js でグラフィカルに可視化するショーケースプロジェクト。

**目的：** ハッシュタグコミュニティのユーザーネットワーク構造を可視化し、AT Protocol の実装例を示す。

---

## プロジェクト構成

```
bluesky-sigma-showcase/
├── lambda/
│   └── handlers/
│       ├── graph_crawler/       # バックエンド：クロール処理
│       │   ├── handler.py
│       │   └── config.json
│       └── graph_api/           # API エンドポイント
│           └── handler.py
├── cdk/                          # AWS インフラストラクチャー
│   ├── app.ts
│   ├── lib/
│   │   └── bluesky_sigma_stack.ts
│   └── package.json
├── frontend/                     # Sigma.js フロントエンド（TBD）
├── data/
│   └── stable_hashtags.json     # 集計済みハッシュタグデータ
├── requirements.txt              # Python 依存ライブラリ
└── README.md
```

---

## アーキテクチャ

```
AT Protocol API
      ↓
Lambda (Graph Crawler)
  ├─→ DID 検索
  ├─→ プロフィール取得
  ├─→ フォロー関係構築
  └─→ グラフ JSON 生成
      ↓
   S3 (Graph Data)
      ↓
API Gateway + Lambda (Graph API)
      ↓
CloudFront + S3 (Frontend)
      ↓
Sigma.js (Browser Visualization)
```

---

## セットアップ

### 前提条件
- AWS アカウント
- AWS CLI 設定済み
- Node.js 18+
- Python 3.12+

### インストール

1. **依存ライブラリをインストール**
   ```bash
   pip install -r requirements.txt
   ```

2. **CDK 依存ライブラリをインストール**
   ```bash
   cd cdk && npm install && cd ..
   ```

3. **Lambda レイヤーを構築**
   ```bash
   mkdir -p lambda/layers/dependencies/python
   pip install -r requirements.txt -t lambda/layers/dependencies/python/
   ```

---

## デプロイ

### AWS CDK でデプロイ

```bash
cd cdk
cdk deploy --require-approval never
```

デプロイ後、以下が出力されます：
- GraphDataBucketName
- FrontendBucketName
- ApiEndpoint
- CloudFrontDistributionDomain

---

## 使用方法

### 1. グラフ クロール実行

手動実行：
```bash
aws lambda invoke --function-name bluesky-sigma-graph-crawler response.json
cat response.json
```

**または** EventBridge で自動スケジュール実行（毎日 00:00 UTC = 09:00 JST）

### 2. API からグラフデータ取得

```bash
# 最新グラフ取得
curl https://<API_ENDPOINT>/api/graph/latest

# 特定ハッシュタグの最新グラフ取得
curl https://<API_ENDPOINT>/api/graph/おはようvtuber/latest

# 利用可能なハッシュタグ一覧取得
curl https://<API_ENDPOINT>/api/hashtags
```

### 3. フロントエンド デプロイ

```bash
cd frontend
npm run build
aws s3 sync dist/ s3://<FRONTEND_BUCKET>/
aws cloudfront create-invalidation --distribution-id <DIST_ID> --paths "/*"
```

CloudFront URL でアクセス可能。

---

## 設定

### config.json（Lambda クロール）

```json
{
  "target_hashtags": ["おはようvtuber"],
  "crawler": {
    "users_per_hashtag": 500,
    "rate_limit_per_second": 5
  },
  "storage": {
    "s3_bucket": "bluesky-sigma-showcase",
    "s3_prefix": "sigma-graph/"
  }
}
```

- `target_hashtags`: クロール対象のハッシュタグ（複数指定可）
- `users_per_hashtag`: 各ハッシュタグから取得するユーザー数
- `rate_limit_per_second`: AT Protocol API の呼び出しレート制限

---

## API エンドポイント

### GET /api/graph/latest
最新グラフ JSON を取得（最初に利用可能なハッシュタグ）

**Response:**
```json
{
  "nodes": [
    {
      "id": "did:plc:...",
      "label": "user.bsky.social",
      "followersCount": 100,
      "followsCount": 50,
      "size": 10
    }
  ],
  "edges": [
    {
      "source": "did:plc:abc...",
      "target": "did:plc:xyz...",
      "type": "follows"
    }
  ],
  "metadata": {
    "hashtag": "おはようvtuber",
    "timestamp": "2026-04-08T00:00:00+09:00",
    "nodeCount": 500,
    "edgeCount": 1200
  }
}
```

### GET /api/graph/{hashtag}/latest
特定ハッシュタグの最新グラフ JSON を取得

### GET /api/hashtags
利用可能なハッシュタグ一覧を取得

---

## コスト試算（月額）

| リソース | コスト |
|---------|--------|
| Lambda | $0.22 |
| S3 | $1 |
| CloudFront | $2-3 |
| API Gateway | $0.50 |
| CloudWatch | $1 |
| **合計** | **約 $5-6** |

初年度は AWS 無料枠を活用して実質 $2-3/月。

---

## 今後の拡張

- [ ] Sigma.js フロントエンド実装
- [ ] 時系列グラフ比較
- [ ] コミュニティ検出（Louvain アルゴリズム）
- [ ] ノード検索機能
- [ ] 複数ハッシュタグの交差表示

---

## ライセンス

MIT License

---

## 参考資料

- [AT Protocol](https://atproto.com/)
- [Bluesky](https://bsky.app/)
- [Sigma.js](https://www.sigmajs.org/)
- [AWS CDK](https://aws.amazon.com/cdk/)
