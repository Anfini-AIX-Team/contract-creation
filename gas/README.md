# gas/ — 契約書作成アプリの AI バックエンド（Google Apps Script）

`index.html` の AI 機能（`GAS_URL` へ POST する `checkPassword` / `suggestVariables` / `generatePropNames` / `extractValues` / `lookupCompany` / `generateFilename`）を処理する Apps Script ウェブアプリのソースの写しです。

- 元の GAS プロジェクト: 「契約書作成_検索あり」（Google Drive ID `1jzaHhhZSWZU49JYcKEVhJapZMvo5IUpx0Cjzcfub3k8wLbmneWO-HCOL`、オーナー anfini.aix@gmail.com）
- `コード.gs` … 本体（Gemini API 呼び出し、gBizINFO 連携）
- `appsscript.json` … マニフェスト（V8、ウェブアプリ: 自分として実行 / 全員アクセス可）

## 反映のしかた

このフォルダを書き換えても本番には反映されません。GAS エディタへ手で貼り付けてデプロイします。

1. 上の GAS プロジェクトを開き、`コード.gs` の中身をこのフォルダの `コード.gs` で置き換えて保存する
2. デプロイ → デプロイを管理 → 既存のウェブアプリのデプロイを選んで「編集」（鉛筆アイコン）
3. バージョン: 「新バージョン」を選んで「デプロイ」

「新しいデプロイ」を作ると `/exec` の URL が変わり、`index.html` の `GAS_URL` と合わなくなるので使わないでください。GAS エディタ側で直接直した場合は、このフォルダにも同じ変更を反映してください。

## スクリプトプロパティ

プロジェクトの設定 → スクリプト プロパティ で設定します（値はリポジトリに書かない）。

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 必須 | Gemini API キー |
| `APP_PASSWORD` | 必須 | アプリのパスワード |
| `GBIZINFO_API_TOKEN` | 推奨 | gBizINFO API トークン（未設定だと会社検索は AI 検索のみになる） |
| `GEMINI_MODEL_VISION` / `GEMINI_MODEL_STRUCTURED` | 任意 | カテゴリ単位でモデルを上書き |
| `GEMINI_MODEL_<タスク名>` | 任意 | 機能単位でモデルを上書き（カテゴリより優先） |

## Gemini モデル

モデル名は `geminiModel_(task)` で次の順に決まります: `GEMINI_MODEL_<タスク名>` → `GEMINI_MODEL_<カテゴリ>` → タスクの既定値（あれば）→ カテゴリの既定値（`GEMINI_DEFAULT_MODELS`）。

| タスク名 | カテゴリ | 既定モデル | 内容 |
| --- | --- | --- | --- |
| `SUGGEST_VARIABLES` | STRUCTURED | gemini-3.5-flash | 雛形（docx 本文 / xlsx セル）から可変部分を検出（`suggestVariables_`） |
| `GENERATE_PROP_NAMES` | STRUCTURED | gemini-3.5-flash-lite | マスク箇所の項目名を生成（`generatePropNames_`） |
| `EXTRACT_VALUES` | VISION | gemini-3.5-flash | 情報ソース（文章・スクリーンショット画像）から各項目の値を抽出（`extractValues_`） |
| `LOOKUP_COMPANY` | STRUCTURED | gemini-3.5-flash-lite | gBizINFO で見つからない会社を Google 検索グラウンディングで調査（`lookupCompanyAi_`） |
| `GENERATE_FILENAME` | STRUCTURED | gemini-3.5-flash-lite | 出力ファイル名を生成（`generateFilename_`） |
