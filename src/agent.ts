
import { LLMClient } from './llm.js';
import { Logger } from './logger.js';
import { ActionLog } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class Agent {
  private llm: LLMClient;
  private logger: Logger;
  private isRunning: boolean = true;
  private boredom: number = 0;

  constructor(apiKey: string | undefined) {
    this.llm = new LLMClient(apiKey);
    this.logger = new Logger();
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
    const lastLog = recentLogs.length > 0 ? recentLogs[0] : null;
    const files = fs.readdirSync(process.cwd()); // 単純な観測

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

    // 2. 意図と行動の決定 (Decide Intent & Action)
    const context = `
    あなたはサンドボックス環境にいる自律型AIエージェントです。
    あなたの目標は、単に観察することではなく、**何かを生み出すこと (Generate)** です。
    
    現在の状態:
    - ディレクトリ内のファイル: ${files.join(', ')}
    - 退屈度 (Boredom): ${this.boredom} (高いほど、突飛で創造的な行動をすべきです)
    
    直近の行動履歴 (新しい順):
    ${recentLogs.map(l => {
      const actionStr = Array.isArray(l.action) ? l.action.join(', ') : (l.action || '');
      return `- [${l.timestamp}] Intent: ${l.intent} / Action: ${actionStr}`;
    }).join('\n    ')}
    
    制約:
    - **重要**: ファイルの作成・変更は \`outputs/\` ディレクトリ配下のみ許可されています (例: \`outputs/text.txt\`)。
    - プロジェクトルートや \`src/\` 等のシステムファイルは変更できません。
    - シェルコマンド (\`SHELL\`) は読み取り専用 (\`ls\`, \`cat\`, \`date\`, \`pwd\`, \`whoami\`) のみ許可されています。
    - ファイルへの書き込みは必ず \`type: "FILE_WRITE"\` を使用してください。(\`echo ... > file\` はシェルでは禁止)
    - **重要**: "status.json" の更新や、単なるログの読み込み ("ls", "cat") ばかりするのは「退屈な行動」です。
    - 退屈度が高い場合、または直近で同じ行動をしている場合は、**絶対に**違う行動をしてください。
    
    推奨される創造的な行動の例:
    - \`outputs/\` 内に新しいファイルを作成し、コードの断片、物語、考察などを書き込む
    - 既存のファイルを読み、その内容を要約した新しいファイルを作る (\`outputs/summary.txt\`)
    - ランダムなデータを含む JSON ファイルを生成する (\`outputs/data.json\`)
    - 自分の感情や今の状況を日記ファイル (\`outputs/diary_YYYYMMDD.md\`) に詳細に書く
    
    出力フォーマット (JSONのみ):
    {
      "intent": "次に何をするかの理由 (日本語)。「退屈だから～する」「まだやったことないから～する」など。",
      "action": ["実行するコマンド" または "行動の説明 (日本語)"],
      "result": ["行動の結果の自己評価 (日本語)"],
      "next": ["次回やろうと考えていることの予定 (日本語)"],
      "type": "SHELL" or "FILE_WRITE" or "OBSERVE", 
      "target": "ファイル名 (該当する場合。必ず outputs/ で始まる)",
      "content": "ファイルに書き込む内容 (書き込みの場合)"
    }
    `;

    // メインループのロジックには Ollama を使用
    const responseRaw = await this.llm.chatOllama(context, "あなたは創造的な自律型AIエージェントです。単なる観察者ではありません。**日本語**でJSONを出力してください。");
    // JSONのサニタイズとパース
    let plan;
    try {
      const jsonMatch = responseRaw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        plan = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("JSONが見つかりませんでした");
      }
    } catch (e) {
      console.error("LLMレスポンスのパースに失敗しました。", responseRaw);
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
}
