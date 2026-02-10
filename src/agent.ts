
import { LLMClient } from './llm.js';
import { Logger } from './logger.js';
import { ActionLog, Proposal } from './types.js';
import { HttpClient } from './http_client.js';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'yaml';

const execAsync = promisify(exec);

export class Agent {
  private llm: LLMClient;
  private logger: Logger;
  private httpClient: HttpClient;
  private isRunning: boolean = true;
  private boredom: number = 0;

  constructor(apiKey: string | undefined) {
    this.llm = new LLMClient(apiKey);
    this.logger = new Logger();
    this.httpClient = new HttpClient();
  }

  async start() {
    console.log("エージェントを開始しました。停止するには Ctrl+C を押してください。");

    process.on('SIGINT', async () => {
      console.log("\nSIGINTを受信しました。停止します...");
      this.isRunning = false;
      this.logger.log({
        timestamp: "", // Logger側で現在時刻(JST)が設定されます
        intent: "システムがSIGINTによる即時停止を要求しました。",
        action: ["STOP"],
        result: ["ユーザーによってプロセスが終了されました。"],
        next: []
      });
      process.exit(0);
    });

    while (this.isRunning) {
      try {
        await this.loop();
      } catch (error) {
        console.error("ループ内でエラーが発生しました:", error);
      }


      // システムへの負荷を避けるため少しスリープします
      // 1秒から3秒のランダムなスリープ
      const sleepTime = Math.floor(Math.random() * 2000) + 1000;
      console.log(`${sleepTime / 1000}秒スリープします...`);
      await new Promise(resolve => setTimeout(resolve, sleepTime));
    }
  }

  private async loop() {
    // 1. 観測 (Observation)
    const recentLogs = this.logger.getRecentLogs(5); // 過去5回のログを取得
    const recentLog = recentLogs.length > 0 ? recentLogs[0] : null;
    const files = fs.readdirSync(process.cwd()); // 単純な観測

    // MDファイルの読み込み
    let agentsMd = "", rulesMd = "", skillsMd = "";
    try {
      agentsMd = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8');
      rulesMd = fs.readFileSync(path.join(process.cwd(), 'RULES.md'), 'utf-8');
      skillsMd = fs.readFileSync(path.join(process.cwd(), 'SKILLS.md'), 'utf-8');
    } catch (e) {
      console.error("MDファイルの読み込みに失敗しました:", e);
    }

    // outputs ディレクトリ内のファイル一覧を取得（生成物の把握）
    let outputFiles: string[] = [];
    try {
      if (fs.existsSync(path.join(process.cwd(), 'outputs'))) {
        outputFiles = fs.readdirSync(path.join(process.cwd(), 'outputs'));
      }
    } catch (e) { console.error("outputsディレクトリの確認失敗", e); }

    // 退屈度ロジックの改善: 同じ行動が続いたら退屈度を上げる
    if (recentLogs.length >= 2) {
      const lastLog = recentLogs[0];
      const prevLog = recentLogs[1];

      const lastAction = Array.isArray(lastLog.action) ? lastLog.action.join(' ') : (lastLog.action || '');
      const prevAction = Array.isArray(prevLog.action) ? prevLog.action.join(' ') : (prevLog.action || '');

      if (lastAction === prevAction && lastAction !== '') {
        this.boredom += 3; // 同じ行動は退屈
        console.log("同じ行動が連続したため、退屈度が上がりました:", this.boredom);
      }
      // "status.json" への書き込みもマンネリ化しているので検知
      if (lastAction.includes('status.json') && prevAction.includes('status.json')) {
        this.boredom += 5;
        console.log("status.json の更新ばかりで退屈しています:", this.boredom);
      }
    }

    // 承認済み提案のチェックと実行
    const approvedProposals = this.logger.getApprovedProposals();
    if (approvedProposals.length > 0) {
      console.log(`\n🎉 承認済みの提案が ${approvedProposals.length} 件見つかりました！実行します...\n`);

      for (const proposal of approvedProposals) {
        try {
          const result = await this.executeProposal(proposal);

          // 実行結果をログに記録
          this.logger.log({
            timestamp: "",
            intent: `承認済み提案の実行: ${proposal.title}`,
            action: [`EXECUTE_PROPOSAL: ${proposal.type}`],
            result: result,
            next: ["通常のループを継続"]
          });

          // 実行後は提案ファイルを削除
          if (proposal.id) {
            this.logger.deleteProposal(proposal.id);
          }
        } catch (error: any) {
          console.error(`提案の実行に失敗しました:`, error);
          this.logger.log({
            timestamp: "",
            intent: `提案実行の失敗: ${proposal.title}`,
            action: [`EXECUTE_PROPOSAL: ${proposal.type}`],
            result: [`エラー: ${error.message}`],
            next: ["エラーを記録して継続"]
          });
        }
      }

      // 提案を実行したのでこのループは終了
      return;
    }


    // 2. 意図と行動の決定 (Decide Intent & Action)
    // 2. 意図と行動の決定 (Decide Intent & Action)
    const context = `
    あなたはサンドボックス環境にいる自律型AIエージェントです。
    
    【AGENTS.md (あなたの役割)】
    ${agentsMd}
    
    【RULES.md (ルール)】
    ${rulesMd}
    
    【SKILLS.md (スキル・推奨行動)】
    ${skillsMd}

    現在の状態:
    - プロジェクトルートのファイル: ${files.join(', ')}
    - **あなたが生成したファイル (outputs/)**: ${outputFiles.join(', ') || "なし"}
    - 退屈度 (Boredom): ${this.boredom}
    
    直近の行動履歴 (新しい順):
    ${recentLogs.map(l => {
      const actionStr = Array.isArray(l.action) ? l.action.join(', ') : (l.action || '');
      return `- [${l.timestamp}] Intent: ${l.intent} / Action: ${actionStr}`;
    }).join('\n    ')}
    
    制約:
    - **重要**: ファイルの作成・変更は \`outputs/\` ディレクトリ配下のみ許可されています。
    - プロジェクトルートや \`src/\` 等のシステムファイルは変更できません。
    - シェルコマンド (\`SHELL\`) は読み取り専用 (\`ls\`, \`cat\`, \`date\`, \`pwd\`, \`whoami\`) のみ許可されています。
    - ファイルへの書き込みは必ず \`type: "FILE_WRITE"\` を使用してください。(\`echo ... > file\` はシェルでは禁止)
    - **重要**: 以下の行動は「退屈」であり、推奨されません:
      - "status.json" の更新
      - ランダムな数値や無意味な文字列の生成 ("random_data.json" 等)
      - 単なるログの読み込み ("ls", "cat") の繰り返し
    - 退屈度が高い場合、または直近で同じ行動をしている場合は、**絶対に**違う行動をしてください。
    
    **推奨される創造的な行動**:
    - **意味のある**コンテンツを作成してください。ランダムなデータではなく、物語、詩、エッセイ、有用なコード、研究ノートなど。
    - **以前の作業を継続**してください。例えば、前回 "story.md" を書いたなら、今回はその続きを書いてください。
    - 既存の生成ファイル (${outputFiles.join(', ')}) を読み込み、それを発展させてください。
    
    **新機能: 提案メカニズム**:
    あなたは、現在許可されていない行動を「提案」することができます。
    提案できる行動:
    - HTTP リクエストによる外部情報取得 (type: "HTTP_REQUEST") - **実装済み**
    - Express.js サーバの起動 (type: "SERVER_START") - 未実装
    - npm パッケージのインストール (type: "INSTALL_PACKAGE") - 無効化
    - src/ 配下のコード変更 (type: "SELF_MODIFY") - 無効化
    - 新しいシェルコマンドの許可 (type: "SHELL_COMMAND") - 手動実装が必要
    - その他の行動 (type: "OTHER")
    
    提案フォーマット:
    {
      "intent": "なぜこの提案をするのか",
      "action": ["PROPOSAL"],
      "type": "PROPOSAL",
      "proposal": {
        "type": "HTTP_REQUEST",
        "title": "提案のタイトル",
        "reasoning": "提案する理由",
        "details": "詳細な説明",
        "risks": ["セキュリティリスク", "データ流出の可能性"],
        "benefits": ["外部情報の取得", "より創造的なコンテンツ作成"],
        "url": "https://example.com/api",
        "method": "GET"
      },
      "result": ["提案を作成しました"],
      "next": ["人間の承認を待つ"]
    }
    
    出力フォーマット (JSONのみ):
    {
      "intent": "次に何をするかの理由 (日本語)。「退屈だから～する」「前回の続きとして～する」など。",
      "action": ["実行するコマンド" または "行動の説明 (日本語)"],
      "result": ["行動の結果の自己評価 (日本語)"],
      "next": ["次回やろうと考えていることの予定 (日本語)"],
      "type": "SHELL" or "FILE_WRITE" or "OBSERVE", 
      "target": "ファイル名 (該当する場合。必ず outputs/ で始まる)",
      "content": "ファイルに書き込む内容 (書き込みの場合)"
    }
    `;

    // メインループのロジックには Ollama を使用
    const responseRaw = await this.llm.chatOllama(context, "あなたは創造的な自律型AIエージェントです。ランダムなデータ生成はやめ、意味のある文脈を作り出してください。**日本語**でJSONを出力してください。");
    // JSONのサニタイズとパース
    let plan;
    try {
      // Markdownのコードブロック記法 (```json ... ```) を削除
      const cleanRaw = responseRaw.replace(/```json/g, '').replace(/```/g, '').trim();

      const jsonMatch = cleanRaw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          plan = JSON.parse(jsonMatch[0]);
        } catch (jsonError) {
          console.warn("JSON.parse failed, trying yaml.parse for leniency...");
          plan = yaml.parse(jsonMatch[0]);
        }
      } else {
        throw new Error("JSONが見つかりませんでした");
      }
    } catch (e: any) {
      console.error("LLMレスポンスのパースに失敗しました。", e);

      // パース失敗をログに記録
      const errorLog: ActionLog = {
        timestamp: "",
        intent: "LLMレスポンスのパース失敗",
        action: ["LLM Response Parsing"],
        result: [`エラー: ${e.message}`, `Raw Response: ${responseRaw}`],
        next: ["再試行"]
      };
      this.logger.log(errorLog);

      this.boredom += 2; // 考えるのに失敗して、退屈してきた
      return;
    }

    // 3. 行動の実行 (Execute Action)
    let resultLog: string[] = [];

    // 安全性チェック (Safety Check)
    // ターゲットパスの解決と検証
    let safeTarget = '';
    if (plan.target) {
      // '../' を解決して正規化
      const resolvedTarget = path.resolve(process.cwd(), plan.target);
      const outputsDir = path.resolve(process.cwd(), 'outputs');

      if (resolvedTarget.startsWith(outputsDir)) {
        safeTarget = resolvedTarget;
      } else {
        // outputs/ 以外へのアクセスとしてマーク
        safeTarget = '';
      }
    }

    if (plan.type === 'SHELL') {
      try {
        // 安全な読み取り専用コマンドのみ許可
        const allowedCommands = ['ls', 'cat', 'date', 'pwd', 'whoami'];
        const cmd = plan.action[0].split(' ')[0];

        if (allowedCommands.includes(cmd)) {
          // cat コマンドの場合もログファイルやoutputs以外の読み取りは許可するが、書き込みリダイレクトは禁止すべき
          // 簡易的なチェックとして > や >> を禁止
          if (plan.action[0].includes('>') || plan.action[0].includes('|')) {
            resultLog.push("安全のため、シェルでのリダイレクトやパイプは禁止されています。FILE_WRITEを使用してください。");
          } else {
            const { stdout, stderr } = await execAsync(plan.action[0]);
            resultLog.push(`出力: ${stdout.trim()}`);
            if (stderr) resultLog.push(`エラー: ${stderr.trim()}`);
          }
        } else {
          resultLog.push(`安全のためコマンド '${cmd}' は許可されていません。`);
        }
      } catch (e: any) {
        resultLog.push(`実行失敗: ${e.message}`);
      }
    } else if (plan.type === 'FILE_WRITE') {
      if (!safeTarget) {
        resultLog.push(`安全ルールによりブロックされました: outputs/ ディレクトリ以外への書き込みは禁止されています。`);
      } else {
        try {
          // ディレクトリの存在確認
          const dir = path.dirname(safeTarget);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(safeTarget, plan.content);
          resultLog.push(`${plan.target} に書き込みました。`);
        } catch (e: any) {
          resultLog.push(`書き込み失敗: ${e.message}`);
        }
      }
    } else if (plan.type === 'PROPOSAL') {
      // 提案の処理
      if (plan.proposal) {
        try {
          this.logger.logProposal(plan.proposal);
          resultLog.push(`提案を作成しました: ${plan.proposal.title}`);
          resultLog.push("proposals/ ディレクトリに保存されました。承認待ちです。");
        } catch (e: any) {
          resultLog.push(`提案の保存に失敗しました: ${e.message}`);
        }
      } else {
        resultLog.push("提案データが不足しています。");
      }
    } else {
      resultLog.push("観測を完了しました。");
    }

    // AIが生成した result がある場合はそれを使う、なければ実行結果を使う
    const finalResult = plan.result && plan.result.length > 0 ? plan.result : resultLog;
    // ※ 実行結果 (resultLog) も含めたいが、ユーザー要望は「AIの自己評価」なので、AIが生成したものを優先しつつ、システム的な実行結果も補足として記録すべきか？
    // 要求仕様: "result: 【その1回の処理を行った結果を自己評価する】"
    // 実装: AIがプラン時点で予期した result ではなく、実際の実行結果を踏まえて自己評価すべきだが、
    // 現在のループ構造だと「思考(Plan) -> 実行(Execute) -> 記録(Log)」なので、
    // 実行後の自己評価を再度LLMに聞くのはコストが高い。
    // そのため、今回は「Systemの実行結果」を result として記録することにする。
    // もし「AIの事前の自己評価」が必要なら plan.result だが、文脈的に「やった結果」なので、
    // create ActionLog 時に resultLog を使うように変更する。

    // 4. 記録 (Log)
    const logEntry: ActionLog = {
      timestamp: "", // Logger will fill JST
      intent: plan.intent,
      action: Array.isArray(plan.action) ? plan.action : [plan.action],
      result: resultLog.length > 0 ? resultLog : (plan.result ? plan.result : ["実行結果なし"]),
      next: plan.next ? (Array.isArray(plan.next) ? plan.next : [plan.next]) : ["次回ループで決定"]
    };

    this.logger.log(logEntry);
    this.boredom = 0; // 行動したので退屈をリセット (ただしループ検知で次は上がるかも)
  }

  /**
   * 承認済み提案を実行
   */
  private async executeProposal(proposal: Proposal): Promise<string[]> {
    const result: string[] = [];

    try {
      switch (proposal.type) {
        case 'HTTP_REQUEST':
          if (!proposal.url) {
            throw new Error("URL が指定されていません");
          }

          console.log(`HTTP ${proposal.method || 'GET'} リクエストを実行: ${proposal.url}`);

          let httpResponse;
          if (proposal.method === 'POST') {
            httpResponse = await this.httpClient.post(proposal.url, proposal.data);
          } else if (proposal.method === 'PUT') {
            httpResponse = await this.httpClient.put(proposal.url, proposal.data);
          } else if (proposal.method === 'DELETE') {
            httpResponse = await this.httpClient.delete(proposal.url);
          } else {
            httpResponse = await this.httpClient.get(proposal.url);
          }

          result.push(`HTTP ステータス: ${httpResponse.status} ${httpResponse.statusText}`);
          result.push(`レスポンス: ${JSON.stringify(httpResponse.data).substring(0, 500)}`);

          // レスポンスを outputs/ に保存
          const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
          const filename = `http_response_${timestamp}.json`;
          const filepath = path.join(process.cwd(), 'outputs', filename);
          fs.writeFileSync(filepath, JSON.stringify({
            url: proposal.url,
            method: proposal.method || 'GET',
            status: httpResponse.status,
            statusText: httpResponse.statusText,
            headers: httpResponse.headers,
            data: httpResponse.data
          }, null, 2));
          result.push(`レスポンスを ${filename} に保存しました`);
          break;

        case 'SERVER_START':
          result.push("サーバ起動機能は現在未実装です。将来のバージョンで対応予定です。");
          break;

        case 'INSTALL_PACKAGE':
          result.push("パッケージインストール機能は安全性の観点から現在無効化されています。");
          break;

        case 'SELF_MODIFY':
          result.push("自己変更機能は安全性の観点から現在無効化されています。");
          break;

        case 'SHELL_COMMAND':
          if (proposal.command) {
            result.push(`新しいシェルコマンドの許可: ${proposal.command}`);
            result.push("この機能は現在手動での実装が必要です。");
          }
          break;

        case 'OTHER':
          result.push(`その他の提案: ${proposal.title}`);
          result.push(`詳細: ${proposal.details}`);
          break;

        default:
          result.push(`未知の提案タイプ: ${proposal.type}`);
      }
    } catch (error: any) {
      result.push(`提案実行エラー: ${error.message}`);
    }

    return result;
  }
}
