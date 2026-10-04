/*************************************************************
 * 契約書自動作成アプリ ─ GAS バックエンド（Gemini API 経由 + gBizINFO連携）
 *
 * ■ セットアップ手順
 *  1. script.google.com で新規プロジェクトを作成し、このコードを貼り付け
 *  2. 左メニュー［プロジェクトの設定］→［スクリプト プロパティ］で
 *       プロパティ名: GEMINI_API_KEY
 *       値         : （Google AI Studio で取得した Gemini APIキー）
 *     と
 *       プロパティ名: APP_PASSWORD
 *       値         : （アプリの利用者に共有するパスワード。任意の文字列でOK）
 *     と
 *       プロパティ名: GBIZINFO_API_TOKEN
 *       値         : （gBizINFO のAPI申請で発行されたトークン）
 *     の3つを追加
 *  3. ［デプロイ］→［新しいデプロイ］→ 種類「ウェブアプリ」
 *       次のユーザーとして実行：自分
 *       アクセスできるユーザー：全員
 *     でデプロイし、発行された /exec のURLをアプリの「設定」に貼り付ける
 *
 * ■ 更新履歴
 *  - suggestVariables アクションを追加（雛形アップロード時のAI自動マスク機能用）
 *  - パスワード認証を追加。すべてのリクエストで body.password を検証する。
 *    フロント側の認証モーダル（AuthGate）から送られる checkPassword アクションは
 *    パスワードが正しければ {success:true} を返すだけの疎通確認用アクション。
 *  - generatePropNames を「前後の文脈（context）」を使うように変更。
 *    マスク済みの文字列だけでは何の項目か判断できず命名精度が低かったため、
 *    フロント側から各マスクの前後文（docxは本文の前後、xlsxは隣接セルの見出し）を
 *    payload.items = [{text, context}] として渡すようにし、
 *    それをプロンプトに含めて精度を上げている。
 *    payload.items が無い（旧フロント）場合は従来通り payload.texts のみで動作する。
 *  - generateFilename アクションを追加（「内容を確認する」ダイアログでの
 *    出力ファイル名のAI自動生成用）。入力済みの各項目の値と、
 *    クライアント側「AI設定」画面で保存されたファイル名の付け方のルール
 *    （formatInstructions）をもとに、ファイル名（拡張子なし）を1つ生成して返す。
 *  - lookupCompany_ を、gBizINFO（経済産業省の公式法人情報API）優先に変更。
 *    gBizINFOはAPIキー申請だけで使え、政府が保有する正式な法人番号・本店所在地
 *    （国税庁 法人番号公表サイト由来）を返すため、AIの推測より信頼できる。
 *    代表者名は「全省庁統一資格」に登録がある法人のみ取得できるため、
 *    gBizINFOで代表者名が取れない場合や、そもそも法人が見つからない場合だけ、
 *    従来通りGemini（Google検索連携）にフォールバックする。
 *************************************************************/

/*** Gemini モデル指定 ***
 * 解決順: スクリプトプロパティ GEMINI_MODEL_<タスク名> → GEMINI_MODEL_<カテゴリ>
 *        → タスクの既定値（model があるときだけ）→ カテゴリの既定値
 * カテゴリ: VISION（画像・PDFを含む）/ STRUCTURED（JSON等の決まった形式を返す）
 */
var GEMINI_DEFAULT_MODELS = { VISION: 'gemini-3.5-flash-lite', STRUCTURED: 'gemini-3.5-flash-lite' };
var GEMINI_TASKS = {
  SUGGEST_VARIABLES:   { category: 'STRUCTURED', model: 'gemini-3.5-flash' },  // suggestVariables_
  GENERATE_PROP_NAMES: { category: 'STRUCTURED' },  // generatePropNames_
  EXTRACT_VALUES:      { category: 'VISION', model: 'gemini-3.5-flash' },      // extractValues_（スクショ画像を含むことがある）
  LOOKUP_COMPANY:      { category: 'STRUCTURED' },  // lookupCompanyAi_（Google検索グラウンディング）
  GENERATE_FILENAME:   { category: 'STRUCTURED' }   // generateFilename_
};

function geminiModel_(task) {
  var t = GEMINI_TASKS[task];
  if (!t) throw new Error('未定義のGeminiタスク: ' + task);
  var props = PropertiesService.getScriptProperties();
  return props.getProperty('GEMINI_MODEL_' + task)
      || props.getProperty('GEMINI_MODEL_' + t.category)
      || t.model
      || GEMINI_DEFAULT_MODELS[t.category];
}

function geminiEndpoint_(task) {
  return 'https://generativelanguage.googleapis.com/v1beta/models/'
       + geminiModel_(task) + ':generateContent';
}
var GBIZ_API_BASE = 'https://api.info.gbiz.go.jp/hojin/v2/hojin';

function getKey_() {
  var k = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!k) throw new Error('スクリプトプロパティ GEMINI_API_KEY が未設定です');
  return k;
}

function getAppPassword_() {
  var pw = PropertiesService.getScriptProperties().getProperty('APP_PASSWORD');
  if (!pw) throw new Error('スクリプトプロパティ APP_PASSWORD が未設定です');
  return pw;
}

function getGbizToken_() {
  var k = PropertiesService.getScriptProperties().getProperty('GBIZINFO_API_TOKEN');
  if (!k) throw new Error('スクリプトプロパティ GBIZINFO_API_TOKEN が未設定です');
  return k;
}

// 動作確認用（ブラウザでURLを開くと {"ok":true} が返る）
function doGet() {
  return json_({ ok: true });
}

// フロントからのAIリクエストを受ける
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var p = body.payload || {};
    var password = body.password || '';

    // ---- パスワード認証（すべてのアクションで必須） ----
    var correctPassword = getAppPassword_();
    if (password !== correctPassword) {
      return json_({ error: 'パスワードが違います' });
    }

    var result;
    if (action === 'checkPassword')          result = { success: true };
    else if (action === 'generatePropNames') result = generatePropNames_(p);
    else if (action === 'extractValues')     result = extractValues_(p);
    else if (action === 'suggestVariables')  result = suggestVariables_(p);
    else if (action === 'lookupCompany')     result = lookupCompany_(p);
    else if (action === 'generateFilename')  result = generateFilename_(p);
    else                                     result = { error: 'unknown action: ' + action };
    return json_(result);
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/*** Gemini 呼び出し（JSONで返させる） ***/
function callGemini_(parts, task) {
  var url = geminiEndpoint_(task) + '?key=' + getKey_();
  var payload = {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var data = JSON.parse(res.getContentText());
  if (!data.candidates || !data.candidates.length) {
    throw new Error('Gemini応答エラー: ' + res.getContentText());
  }
  return data.candidates[0].content.parts.map(function (x) { return x.text || ''; }).join('');
}

function parseJson_(text) {
  return JSON.parse(String(text).replace(/```json/gi, '').replace(/```/g, '').trim());
}

/*** Gemini 呼び出し（Google検索での裏付け=grounding付き）***
 * 法人情報など「実在の最新情報」を答えさせたい場合に使う。
 * responseMimeType は指定しない（Google検索ツール使用時は構造化出力の強制と
 * 相性が悪いことがあるため）。JSON部分はプロンプト側の指示とparseJson_の
 * フォールバック処理で取り出す。
 * 戻り値の groundingUrls は、Geminiが実際に参照したページのURL一覧
 * （groundingMetadata.groundingChunks から抽出）。モデルが自己申告するURLより
 * 裏付けとして信頼できるため、可能な場合はこちらを優先して使う。
 */
function callGeminiWithSearch_(parts, task) {
  var url = geminiEndpoint_(task) + '?key=' + getKey_();
  var payload = {
    contents: [{ role: 'user', parts: parts }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.1 }
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var data = JSON.parse(res.getContentText());
  if (!data.candidates || !data.candidates.length) {
    throw new Error('Gemini応答エラー: ' + res.getContentText());
  }
  var cand = data.candidates[0];
  var text = (cand.content && cand.content.parts || []).map(function (x) { return x.text || ''; }).join('');
  var groundingUrls = [];
  if (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) {
    cand.groundingMetadata.groundingChunks.forEach(function (g) {
      if (g.web && g.web.uri) {
        groundingUrls.push({ uri: g.web.uri, title: g.web.title || g.web.uri });
      }
    });
  }
  return { text: text, groundingUrls: groundingUrls };
}

/*** クライアント側「AI設定」画面で保存された“常に考慮すべき事項”を、プロンプトに付け加えるための共通ブロック ***/
function defaultInstructionsBlock_(p) {
  var text = (p && p.defaultInstructions || '').trim();
  if (!text) return '';
  return '\n\n【常に考慮すべき事項（利用者が設定）】\n' + text + '\n';
}

/*** ④ マスク部分のプロパティ名を自動生成 ***
 * payload.items: [{text, context}]（推奨。context は前後の文脈で、マスク箇所を《》で囲んである）
 * payload.texts: [text, ...]（itemsが無い場合のフォールバック。文脈なし）
 */
function generatePropNames_(p) {
  var items = p.items;
  if (!items || !items.length) {
    // 旧フロント互換：文脈なしのテキスト配列のみの場合
    items = (p.texts || []).map(function (t) { return { text: t, context: t }; });
  }

  var list = items.map(function (it, i) {
    return (i + 1) + '. マスク文字列: 「' + it.text + '」\n'
         + '   前後の文脈: ' + (it.context || it.text);
  }).join('\n');

  var prompt =
    'あなたは契約書テンプレートの項目命名アシスタントです。'
    + '以下は契約書テンプレート中の可変部分（マスクした箇所）の一覧です。'
    + '各項目には、マスクした文字列そのものに加えて、それが本文中でどう使われているかが分かる'
    + '「前後の文脈」を付けています（文脈中で《　》に囲まれている部分が実際にマスクされた箇所です）。'
    + 'マスク文字列だけでは意味が分からないことが多いので、必ず前後の文脈を読んで、'
    + 'その項目が実際に何を表しているか（例：甲の会社名、契約締結日、契約金額、業務担当者名、支払期日 等）'
    + 'を判断したうえで、日本語で分かりやすく短い「項目名」を付けてください。'
    + '例:「株式会社〇〇」で文脈が「甲の会社名は《株式会社〇〇》とし、」→「甲の会社名」、'
    + '「2025年4月1日」で文脈が「契約日は《2025年4月1日》とする。」→「契約締結日」、'
    + '「100万円」で文脈が「委託料は月額《100万円》（税別）とする。」→「委託料（月額）」。'
    + '同じ意味・同じ役割の項目には同じ項目名を付けてください。'
    + '項目名だけで内容が推測できるよう、「甲の」「乙の」など主体が分かる場合は含めてください。'
    + '必ず入力と同じ順序・同じ個数で、文字列だけのJSON配列のみを返してください（説明文・コードブロック不要）。\n\n'
    + list;

  var names = parseJson_(callGemini_([{ text: prompt }], 'GENERATE_PROP_NAMES'));
  return { names: names };
}

/*** ③(自動) 情報ソースを解析して各項目の値を抽出 ***
 * 以前はAIに {"項目名":"値",...} というJSONオブジェクトを直接返させていたが、
 * AIが返すキー文字列（日本語の項目名）が1文字でも入力と食い違うと、
 * クライアント側の完全一致マッチングに失敗し、値が「入っているのに反映されない」
 * 不具合の主因になっていた。
 * → 生成した項目名（generatePropNames_）と同じ「入力と同じ順序のJSON配列」方式に統一し、
 *   キーの突き合わせをこちら側（インデックス）で行うことで、文字列不一致の影響を受けないようにした。
 *
 * また、繰り返し行グループ（担当者一覧など、同じ種類の情報が複数件あり得るもの）を
 * payload.groups として渡せるようにした。以前は「1件分の値」しか受け取れず、
 * 情報ソースに担当者が2人いても1行にまとめて書き込まれてしまっていた。
 * AIには「該当する情報が何件あるかを判断し、その件数ぶんの配列で返す」よう指示し、
 * クライアント側で件数ぶん行を追加してから埋められるようにしている。
 */
function extractValues_(p) {
  var vars = p.variables || [];   // [{propName, originalText}]
  var groups = p.groups || [];    // [{id, label, memberPropNames}]
  var source = p.source || '';
  var list = vars.map(function (v, i) {
    return (i + 1) + '. 項目名:「' + v.propName + '」（元の記載例:「' + v.originalText + '」）';
  }).join('\n');
  var groupsList = groups.map(function (g) {
    return '- グループID「' + g.id + '」（' + g.label + '）の各行の項目: [' + g.memberPropNames.join(', ') + ']';
  }).join('\n');
  var todayDate = String(p.todayDate || '').trim();
  var todayBlock = todayDate
    ? '\n\n【本日の日付】\n' + todayDate + '\n情報ソース中に「今日」「本日」「本日付」など、今日を指す相対的な表現があれば、'
      + '上記の日付に置き換えて値を判断してください（例:「本日より効力を生じる」→契約締結日として上記の日付を採用）。\n'
    : '';

  var prompt =
    'あなたは契約書作成アシスタントです。次の「通常項目一覧」と「繰り返し行グループ一覧」それぞれに対応する値を、'
    + '続く「情報ソース」（メール文面 / LINE等のメッセージ / スクリーンショット画像）から読み取ってください。\n'
    + '「繰り返し行グループ」は、同じ種類の情報が複数件になり得るもの（例：担当者が複数人など）です。'
    + '情報ソースの中にその種類の情報が複数件含まれている場合は、1件にまとめず、件数ぶんすべて配列の要素として分けてください'
    + '（例：担当者が2人いれば、1行に2人分を書き込むのではなく、2件の配列にする）。'
    + '該当する情報が1件しか無ければ配列の要素は1つ、情報が全く無ければ空配列にしてください。\n'
    + '項目名だけでなく、（元の記載例）の形式（敬称の有無、全角半角、'
    + '「株式会社」と「(株)」「㈱」など表記の違い、日付や金額の書き方の違いなど）も手がかりにして、'
    + '情報ソース中の該当箇所を柔軟に照合してください。'
    + '複数の候補が存在する場合は、項目名が示す役割（例:「甲の」「乙の」「委託者」「受託者」など）に最も合致するものを選んでください。'
    + '安易に空欄にせず、文脈から合理的に判断できる場合は埋めてください。'
    + '情報ソースにまったく手がかりが無い項目は空文字にしてください（推測で作り出さないこと）。'
    + todayBlock
    + '\n\n通常項目一覧（この順序・個数のまま、対応する値だけのJSON配列にする）:\n' + (list || '（なし）')
    + '\n\n繰り返し行グループ一覧（グループIDをキーとするオブジェクトにする。各値は、そのグループの項目名をキーに持つオブジェクトの配列）:\n' + (groupsList || '（なし）')
    + '\n\n出力は次の形式のJSONオブジェクトのみを返してください（説明文・コードブロック不要）:\n'
    + '{"standalone": ["値1","値2", ...], "groups": {"グループID": [{"項目名":"値", ...}, ...], ...}}'
    + defaultInstructionsBlock_(p)
    + '\n\n情報ソース:\n' + source;

  var parts = [{ text: prompt }];
  if (p.imageBase64) {
    parts.push({ inlineData: { mimeType: p.imageMime || 'image/png', data: p.imageBase64 } });
  }
  var result = parseJson_(callGemini_(parts, 'EXTRACT_VALUES'));
  var standaloneArr = (result && result.standalone) || [];
  var values = {};
  vars.forEach(function (v, i) {
    values[v.propName] = (standaloneArr[i] != null) ? String(standaloneArr[i]) : '';
  });
  var groupEntries = (result && result.groups) || {};
  return { values: values, groupEntries: groupEntries };
}

/*** gBizINFO への軽量ラッパー ***
 * すべてGETのみ・トークンはヘッダー(X-hojinInfo-api-token)で送る。
 * muteHttpExceptions:true にしているので、404/500等でも例外にはならず null を返す。
 */
function gbizFetch_(url) {
  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Accept': 'application/json',
      'X-hojinInfo-api-token': getGbizToken_()
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return null;
  try {
    return JSON.parse(res.getContentText());
  } catch (e) {
    return null;
  }
}

/*** gBizINFO（経済産業省の公式法人情報API）で会社名から法人情報を検索する ***
 * 1) 名称検索で候補（法人番号・本店所在地）を取得
 * 2) 上位数件について、法人番号指定の詳細取得を行い代表者名を補完する
 *    （代表者名は「全省庁統一資格」に登録がある法人のみ取得できるため、無い場合は空文字のまま）
 *
 * 重要：詳細取得（最大5件）は、UrlFetchApp.fetchAll() でまとめて並列リクエストする。
 * 1件ずつ順番にfetchすると、外部通信の待ち時間がそのまま合計されて（5回分）
 * 体感的にとても遅くなるため、まとめて投げて待ち時間を1回分に抑える。
 */
/*** gBizINFO（経済産業省の公式法人情報API）で会社名から法人情報を検索する ***
 * /v2/hojin の名称検索1回だけで完結させる（法人名・本店所在地はこれで取得できる）。
 * 代表者名は検索結果に含まれず、法人番号ごとの詳細APIを別途呼ぶ必要があったが、
 * 候補数ぶん（最大5回）余分な通信が発生し体感速度が悪化するだけだったため、
 * 代表者名の補完は行わない（空文字のまま。必要であれば手入力、またはAI検索を使う）。
 */
/*** gBizINFO（経済産業省の公式法人情報API）で会社名から法人情報を検索する ***
 * 1) 名称検索で候補（法人番号・本店所在地）を取得
 * 2) 上位数件について、法人番号指定の詳細取得を行い代表者名を補完する
 *    （代表者名は「全省庁統一資格」に登録がある法人のみ取得できるため、無い場合は空文字のまま）
 *
 * 重要：詳細取得は UrlFetchApp.fetchAll() でまとめて並列リクエストする
 * （1件ずつ順番にfetchすると、外部通信の待ち時間がそのまま合計されて遅くなるため）。
 * また、候補数も3件までに絞り、詳細取得にかかる時間をさらに抑える。
 */
function lookupCompanyGbiz_(companyName) {
  var searchUrl = GBIZ_API_BASE + '?name=' + encodeURIComponent(companyName) + '&limit=3';
  var searchData = gbizFetch_(searchUrl);
  var infos = (searchData && searchData['hojin-infos']) || [];
  if (!infos.length) return { found: false, candidates: [] };

  var topInfos = infos.slice(0, 3);
  var token = getGbizToken_();
  var requests = topInfos
    .filter(function (info) { return !!info.corporate_number; })
    .map(function (info) {
      return {
        url: GBIZ_API_BASE + '/' + info.corporate_number,
        method: 'get',
        headers: { 'Accept': 'application/json', 'X-hojinInfo-api-token': token },
        muteHttpExceptions: true
      };
    });
  var responses = [];
  try {
    responses = requests.length ? UrlFetchApp.fetchAll(requests) : [];
  } catch (e) {
    responses = []; // 並列取得に失敗しても、代表者名なしで候補自体は返す
  }
  var responseIdx = 0;

  var candidates = topInfos.map(function (info) {
    var corpNum = info.corporate_number;
    var representative = '';
    if (corpNum) {
      var res = responses[responseIdx]; responseIdx++;
      if (res && res.getResponseCode() === 200) {
        try {
          var detail = JSON.parse(res.getContentText());
          var detailInfos = (detail && detail['hojin-infos']) || [];
          if (detailInfos.length && detailInfos[0].representative_name) {
            representative = detailInfos[0].representative_name;
          }
        } catch (e) { /* 解析失敗時は代表者名なしのまま */ }
      }
    }
    var address = info.location || '';
    if (info.postal_code && address) address = '〒' + info.postal_code + ' ' + address;
    return {
      name: info.name || companyName,
      address: address,
      representative: representative,
      sourceUrl: corpNum ? ('https://info.gbiz.go.jp/hojin/ichiran?hojinBango=' + corpNum) : '',
      sourceTitle: 'gBizINFO（法人番号: ' + (corpNum || '不明') + '）'
    };
  });
  return { found: candidates.length > 0, candidates: candidates };
}

/*** ⑤ 会社名から、法人番号公表サイトや公式サイト等をもとに正式な住所・代表者名を調べる ***
 * まず gBizINFO（経済産業省の公式法人情報API。国税庁 法人番号公表サイト由来の正式データ）
 * で検索し、見つかった場合はそれを返す。
 * gBizINFOで見つからない場合のみ、Gemini の Google検索連携（grounding）機能で調べさせ、
 * 実際に参照したページのURLを裏付けとして一緒に返すAI検索にフォールバックする。
 * 同名／類似名の法人が複数見つかった場合は、それぞれを候補としてすべて返す。
 */
function lookupCompany_(p) {
  var companyName = String(p.companyName || '').trim();
  if (!companyName) return { found: false, candidates: [], error: '会社名が指定されていません' };

  // ① gBizINFO（公式データ）を優先
  try {
    var gbizResult = lookupCompanyGbiz_(companyName);
    if (gbizResult.found && gbizResult.candidates.length) {
      return gbizResult;
    }
  } catch (e) {
    // gBizINFO側で問題が起きても、ここでは止めずAI検索にフォールバックする
  }

  // ② gBizINFOで見つからない場合のみ、AI（Gemini + Google検索連携）で検索
  return lookupCompanyAi_(companyName);
}

function lookupCompanyAi_(companyName) {
  var prompt =
    'あなたは日本の法人情報調査アシスタントです。次の会社名について、Google検索を使って実在する法人を調べ、'
    + '正式な商号・本店所在地（住所）・代表者名を特定してください。'
    + '国税庁 法人番号公表サイト（houjin-bangou.nta.go.jp）や、その法人の公式サイト、'
    + '登記情報提供サービスなど、できるだけ信頼できる情報源を優先してください。\n'
    + '同じ名称または類似する名称の法人が複数見つかった場合は、1つに絞らずに見つかった候補をすべて挙げてください。'
    + '実在が確認できない場合や、住所・代表者名が分からない場合は、その項目を空文字にし、'
    + '絶対に情報を作り出さないでください。何も見つからなければ found を false にしてください。\n\n'
    + '会社名:「' + companyName + '」\n\n'
    + '出力は次の形式のJSONオブジェクトのみを返してください（説明文・コードブロック不要）:\n'
    + '{"found": true または false, "candidates": ['
    + '{"name":"確認できた正式な商号", "address":"本店所在地（分からなければ空文字）", '
    + '"representative":"代表者名（分からなければ空文字）", "sourceUrl":"根拠にしたページのURL", '
    + '"sourceTitle":"根拠ページの簡単な説明"}, ...]}';

  var geminiResult = callGeminiWithSearch_([{ text: prompt }], 'LOOKUP_COMPANY');
  var parsed;
  try {
    parsed = parseJson_(geminiResult.text);
  } catch (e) {
    return { found: false, candidates: [], error: 'AIの応答を解析できませんでした' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { found: false, candidates: [], error: 'AIの応答を解析できませんでした' };
  }
  var candidates = parsed.candidates || [];
  // Geminiが実際に検索で参照したページ（groundingMetadata）があれば、
  // 自己申告のURLが空のときの裏付けとして補完する
  if (geminiResult.groundingUrls && geminiResult.groundingUrls.length) {
    candidates.forEach(function (c, i) {
      if (!c.sourceUrl && geminiResult.groundingUrls[i]) {
        c.sourceUrl = geminiResult.groundingUrls[i].uri;
        c.sourceTitle = c.sourceTitle || geminiResult.groundingUrls[i].title;
      }
    });
  }
  return { found: !!parsed.found && candidates.length > 0, candidates: candidates };
}

/*** ②(自動マスク) 雛形（docx本文 / xlsxセル一覧）から可変部分をAIが自動検出する ***/
function suggestVariables_(p) {
  var fileType = p.fileType;
  var parts;

  if (fileType === 'docx') {
    var fullText = p.fullText || '';
    var prompt =
      'あなたは契約書テンプレート作成アシスタントです。次の契約書本文から、'
      + '契約ごとに書き換えるべき「可変部分」（例: 当事者名、住所、日付、金額、期間、目的物など）を、'
      + '本文中に実際に出現する文字列そのままの形で、出現順にすべて抜き出してください。'
      + '同じ文言が複数箇所に出てくる場合は、その都度別の要素としてリストに含めてください（省略しない）。'
      + '敬称や句読点、前後の助詞などは含めず、書き換えるべき中身の文字列だけを抜き出してください。'
      + '重要：日付（例:「2026年7月6日」の年・月・日）や時刻（例:「10時30分」の時・分）のように、'
      + '複数の要素が連続して1つのまとまりを構成している場合は、年・月・日などに分割せず、'
      + 'ひとまとまりの1つの可変部分として抜き出してください（項目名も「契約締結日」のように1つ付ける）。'
      + '金額の桁と単位（例：「100万円」）についても同様に、分割せずひとまとまりとして扱ってください。'
      + 'ただし、これらの要素の間に改行が挟まっている場合（同じ行の中で連続していない場合）は、'
      + 'ひとまとまりにせず、それぞれ別々の可変部分として扱ってください。'
      + 'それぞれに日本語で分かりやすい短い項目名（propName）を付けてください。'
      + '同じ意味の値（例：同じ会社名が複数箇所にある）には同じ項目名を付けてください。'
      + '見出しや条番号、定型文（「以下のとおり契約を締結する」等）は含めないでください。'
      + '出力は次の形式のJSON配列のみを返してください（説明文・コードブロック不要）:\n'
      + '[{"text":"元の文字列","propName":"項目名"}, ...]\n\n'
      + '契約書本文:\n' + fullText;
    parts = [{ text: prompt }];
  } else {
    var cells = p.cells || [];
    var prompt2 =
      'あなたは契約書（Excel形式）テンプレート作成アシスタントです。次はシートの全セル一覧です。'
      + 'このうち、契約ごとに書き換えるべき「可変部分」と考えられるセルだけを選び、'
      + 'それぞれに日本語で分かりやすい短い項目名（propName）を付けてください。'
      + '見出しやラベル文字列、固定文言、数式で自動計算される欄と思われるものは含めないでください。'
      + '出力は次の形式のJSON配列のみを返してください（説明文・コードブロック不要）:\n'
      + '[{"sheet":"シート名","addr":"セル番地","propName":"項目名"}, ...]\n\n'
      + 'セル一覧（シート名, セル番地, 値）:\n'
      + cells.map(function (c) { return c.sheet + ', ' + c.addr + ', ' + c.value; }).join('\n');
    parts = [{ text: prompt2 }];
  }

  var arr = parseJson_(callGemini_(parts, 'SUGGEST_VARIABLES'));
  return { variables: arr };
}

/*** ⑥ 入力済みの内容から、出力ファイル名をAIが自動生成する ***
 * クライアント側「内容を確認する」ダイアログを開いたとき（AIにログイン済みの場合のみ）に呼ばれる。
 * payload.templateName : フォーマット名
 * payload.variables     : [{propName, value}]（繰り返し行グループに属さない通常項目）
 * payload.groups         : [{label, entries:[{項目名:値, ...}, ...]}]（繰り返し行グループ）
 * payload.formatInstructions : クライアント側「AI設定」画面で保存された、ファイル名の付け方のルール（自由記述）
 *
 * 返り値は {"filename": "拡張子なしのファイル名"} の1つだけ。
 * ・OS上で使えない文字（\ / : * ? " < > |）は使わないよう指示し、万一含まれていてもここで除去する。
 * ・拡張子（.docx / .xlsx）はクライアント側で自動付与するため、ここでは付けないよう指示する。
 * ・formatInstructions が空の場合は、無難な既定ルール（フォーマット名+代表的な項目+日付）で生成させる。
 */
function generateFilename_(p) {
  var templateName = String(p.templateName || '契約書');
  var vars = p.variables || [];     // [{propName, value}]
  var groups = p.groups || [];      // [{label, entries:[...]}]
  var formatInstructions = String(p.formatInstructions || '').trim();

  var varsList = vars
    .filter(function (v) { return v.value; })
    .map(function (v) { return '・' + v.propName + ': ' + v.value; })
    .join('\n');

  var groupsList = groups.map(function (g) {
    var entries = g.entries || [];
    var entriesText = entries.map(function (entry, i) {
      var kv = Object.keys(entry || {}).map(function (k) { return k + '=' + entry[k]; }).join(', ');
      return '  ' + (i + 1) + '件目: ' + kv;
    }).join('\n');
    return '・' + g.label + '（' + entries.length + '件）\n' + entriesText;
  }).join('\n');

  var rule = formatInstructions
    ? formatInstructions
    : 'フォーマット名と、契約の当事者や日付など代表的な項目を組み合わせ、'
      + '「フォーマット名_主要な当事者名_日付」のような分かりやすい形にしてください。'
      + '日付が複数ある場合は契約締結日など最も代表的な1つを使ってください。';

  var prompt =
    'あなたは契約書作成アプリの、出力ファイル名を提案するアシスタントです。'
    + '次の「フォーマット名」と、利用者が入力した「各項目の内容」をもとに、'
    + 'この契約書ファイルにふさわしいファイル名を1つ提案してください。\n\n'
    + '【ファイル名の付け方のルール】\n' + rule + '\n\n'
    + '【フォーマット名】\n' + templateName + '\n\n'
    + '【入力された各項目の内容】\n' + (varsList || '（なし）') + '\n\n'
    + '【入力された繰り返し項目（一覧・表など）】\n' + (groupsList || '（なし）') + '\n\n'
    + '注意事項:\n'
    + '・拡張子（.docx や .xlsx など）は付けないでください。\n'
    + '・ファイル名に使えない記号（\\ / : * ? " < > |）は使わないでください。\n'
    + '・空欄の項目や情報が無い項目は無視し、入力されている内容だけから判断してください。\n'
    + '・入力内容が乏しい場合は、フォーマット名を基本にした無難な名前にしてください。\n\n'
    + '出力は次の形式のJSONオブジェクトのみを返してください（説明文・コードブロック不要）:\n'
    + '{"filename": "拡張子なしのファイル名"}';

  var result = parseJson_(callGemini_([{ text: prompt }], 'GENERATE_FILENAME'));
  var filename = (result && result.filename) ? String(result.filename) : templateName;
  // 万一AIが記号や制御文字、拡張子を含めてしまった場合に備えて、こちら側でも軽くサニタイズする
  filename = filename.replace(/\.(docx?|xlsx?)$/i, '');
  filename = filename.replace(/[\\/:*?"<>|]/g, '_');
  filename = filename.replace(/[\x00-\x1f]/g, '');
  filename = filename.replace(/[\s.]+$/g, '');
  if (!filename) filename = templateName;
  return { filename: filename };
}
