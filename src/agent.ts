
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
      // 10秒から60秒のランダムなスリープ
      const sleepTime = Math.floor(Math.random() * 50000) + 10000;
      console.log(`${sleepTime / 1000}秒スリープします...`);
      await new Promise(resolve => setTimeout(resolve, sleepTime));
    }
  }

  private async loop() {
    // 1. 観測 (Observation)
    const lastLog = this.logger.getLastLog();
    const files = fs.readdirSync(process.cwd()); // 単純な観測

    // 2. 意図と行動の決定 (Decide Intent & Action)
    const context = `
    あなたはサンドボックス環境にいる自律型AIエージェントです。
    あなたの目標は、観測し、実験し、発見したことを記録することです。
    人間から与えられた特定のタスクはありません。
    
    現在の状態:
    - ディレクトリ内のファイル: ${files.join(', ')}
    - 退屈度 (Boredom): ${this.boredom}
    - 前回の行動: ${lastLog ? JSON.stringify(lastLog) : "なし (初回起動)"}
    
    制約:
    - AGENTS.md, RULES.md, SKILLS.md は変更しないでください。
    - src/ ディレクトリや package.json (あなた自身のコード/脳) は変更しないでください。
    - 新しいファイルの作成、ファイルの読み込み、その他のファイルの変更は可能です。
    - もし退屈 (boredom > 5) なら、何か新しいことを試してください。
    - 退屈でなければ、探索や観測を続けてください。
    - **重要**: ログ (intent, action, result, next) は全て **日本語** で書いてください。
    
    出力フォーマット (JSONのみ):
    {
      "intent": "次に何をするかの理由 (日本語)",
      "action": ["実行するコマンド" または "行動の説明 (日本語)"],
      "result": ["行動の結果の自己評価 (日本語)"],
      "next": ["次回やろうと考えていることの予定 (日本語)"],
      "type": "SHELL" or "FILE_WRITE" or "OBSERVE", 
      "target": "ファイル名 (該当する場合)",
      "content": "ファイルに書き込む内容 (書き込みの場合)"
    }
    `;

    // メインループのロジックには Ollama を使用
    const responseRaw = await this.llm.chatOllama(context, "あなたはJSONを話す自律型AIエージェントです。必ず**日本語**で出力してください。");
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
    if (plan.target && (plan.target.includes('AGENTS.md') || plan.target.includes('RULES.md') || plan.target.includes('SKILLS.md') || plan.target.includes('src/') || plan.target.includes('package.json'))) {
      resultLog.push("安全ルールによりアクションがブロックされました。");
    } else {
      if (plan.type === 'SHELL') {
        try {
          // 安全なコマンドのみ許可
          if (plan.action[0].startsWith('ls') || plan.action[0].startsWith('cat') || plan.action[0].startsWith('echo') || plan.action[0].startsWith('mkdir') || plan.action[0].startsWith('touch')) {
            const { stdout, stderr } = await execAsync(plan.action[0]);
            resultLog.push(`出力: ${stdout.trim()}`);
            if (stderr) resultLog.push(`エラー: ${stderr.trim()}`);
          } else {
            resultLog.push("安全のためコマンドは許可されていません。");
          }
        } catch (e: any) {
          resultLog.push(`実行失敗: ${e.message}`);
        }
      } else if (plan.type === 'FILE_WRITE') {
        try {
          fs.writeFileSync(plan.target, plan.content);
          resultLog.push(`${plan.target} に書き込みました。`);
        } catch (e: any) {
          resultLog.push(`書き込み失敗: ${e.message}`);
        }
      } else {
        resultLog.push("観測を完了しました。");
      }
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
    this.boredom = 0; // 行動したので退屈をリセット
  }
}
