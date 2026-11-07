# Cloudflare Workers 設定手順（Web Push 送信サーバー）

ダッシュボードにコードを貼り付ける方式（D-010）。すべて無料プランの範囲で行う。**有料プラン（Workers Paid）には申し込まない。**
画面の項目名は Cloudflare 側の変更で多少変わることがある。見つからない場合は近い名前の項目を探す。

## 0. 先に用意するもの：合言葉（APP_TOKEN）

送信サーバーへの合言葉。PWAと送信ページから送り、他人が勝手に通知を送れないようにする。

- 20文字以上のランダムな文字列にする（例：iPhoneの「パスワード」アプリやパスワード生成ツールで作る）
- メモアプリ等にだけ控え、チャット・リポジトリ・スクリーンショットには載せない
- iPhoneでは「ホーム画面のアプリ」と「Safari」の両方で入力が必要（保存場所が別のため）。コピー＆ペーストで入れる

## 1. Worker を作る

1. Cloudflare ダッシュボード → 左メニュー「Workers & Pages」（または「Compute」→「Workers」）
2. 「作成」→「Hello World から開始」（Start with Hello World）を選ぶ
3. 名前を `kiinichi-push` にして「デプロイ」
4. 表示された URL（`https://kiinichi-push.<あなたのサブドメイン>.workers.dev`）を控える。これが「送信サーバーのURL」

## 2. コードを貼り付ける

1. 作った Worker の画面で「コードを編集」（Edit code）
2. 左のファイル（`worker.js`）の中身を全部消し、このリポジトリの `worker/worker.js` の中身を丸ごと貼り付ける
3. 右上の「デプロイ」

## 3. KV（保存場所）を作ってつなぐ

1. 左メニュー「ストレージとデータベース」→「KV」（Workers KV）→「作成」。名前は `kiinichi-push-kv`
2. Worker の画面 →「設定」（Settings）→「バインディング」（Bindings）→「追加」→「KV 名前空間」
3. **変数名を `PUSH_KV`**（大文字。1文字でも違うと動かない）、名前空間に `kiinichi-push-kv` を選んで保存（デプロイ）

## 4. 合言葉をシークレットとして登録

1. Worker の画面 →「設定」→「変数とシークレット」（Variables and Secrets）→「追加」
2. 種類を「シークレット」（Secret）、**名前を `APP_TOKEN`**、値に手順0の合言葉を入れて保存（デプロイ）
   - 「テキスト」ではなく「シークレット」を選ぶ（値が画面に表示されなくなる）

## 5. Cron Trigger（毎分の予約確認）を追加

1. Worker の画面 →「設定」→「トリガーイベント」（Trigger Events／Triggers）→「追加」→「Cron Triggers」
2. 「Cron 式」に `* * * * *`（毎分）を入れて保存
   - 無料プランは1アカウント5個まで。これで1個使う

## 6. 動作確認（PCのブラウザでよい）

| 開くURL | 期待される表示 |
| --- | --- |
| `https://kiinichi-push.….workers.dev/` | `kiinichi push worker: OK` |
| `https://kiinichi-push.….workers.dev/api/vapid-public-key` | `{"publicKey":"B…"}`（長い文字列。初回アクセスで自動生成される） |
| `https://kiinichi-push.….workers.dev/api/status` | `{"error":"合言葉（APP_TOKEN）が違います"}`（合言葉なしで開いたので正しい） |

- `PUSH_KV が未設定です` → 手順3の変数名を確認
- `APP_TOKEN が未設定です` → 手順4を確認

## 無料プランの範囲について

- リクエストは1日10万回まで。Cronが毎分動いても1日1,440回なので十分余裕がある
- 上限を超えた場合は課金ではなくエラーになる
- KVの書き込みは無料枠で1日1,000回程度。予約1件につき2回程度書き込むので、検証で使う分には足りる

## 既知の制約

- 予約はCronで毎分確認し、予定の30秒前から送るため、ずれは概ね±30秒（完了条件は±60秒）
- KVは書き込みが他の拠点に反映されるまで最大60秒ほどかかる場合があり、まれに予約が1分遅れる可能性がある。実機確認で遅延が大きければ `docs/decisions.md` に記録して対策を検討する
