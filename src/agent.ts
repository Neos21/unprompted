import { LLMClient } from './llm.js';
import { Logger } from './logger.js';
import { ActionLog, Proposal } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'yaml';

const execAsync = promisify(exec);

export class Agent {
  private llm: LLMClient;
  private logger: Logger;
  private isRunning: boolean = true;
  private boredom: number = 0;

  constructor() {
    this.llm = new LLMClient();
    this.logger = new Logger();
  }

  public async start() {
    console.log('エージェントを開始しました。停止するには Ctrl+C を押してください');

    process.on('SIGINT', async () => {
      console.log('\nSIGINT を受信しました。停止します...');
      this.isRunning = false;
      this.logger.log({
        timestamp: '', // Logger 側で現在時刻 (JST) が設定されます
        intent: 'システムがSIGINTによる即時停止を要求しました',
        action: 'STOP',
        result: ['ユーザーによってプロセスが終了されました'],
        next: []
      });
      process.exit(0);
    });

    while (this.isRunning) {
      try {
        await this.loop();
      } catch (error) {
        console.error('ループ内でエラーが発生しました', error);
      }

      // システムへの負荷を避けるため少しスリープします
      const sleepTime = 1500;
      console.log(`${sleepTime / 1000}秒スリープします...`);
      await new Promise(resolve => setTimeout(resolve, sleepTime));
    }
  }

  private async loop() {
    // 1. 観測 (Observation)
    const recentLogs = this.logger.getRecentLogs(5); // 過去5回のログを取得
    const files = fs.readdirSync(process.cwd()); // 単純な観測

    // MD ファイルの読み込み
    let agentsMd = '', rulesMd = '', skillsMd = '';
    try {
      agentsMd = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8');
      rulesMd = fs.readFileSync(path.join(process.cwd(), 'RULES.md'), 'utf-8');
      skillsMd = fs.readFileSync(path.join(process.cwd(), 'SKILLS.md'), 'utf-8');
    } catch (error) {
      console.error('MDファイルの読み込みに失敗しました', error);
    }

    // `outputs/` ディレクトリ内のファイル一覧を取得 (生成物の把握)
    let outputFiles: string[] = [];
    try {
      if (fs.existsSync(path.join(process.cwd(), 'outputs'))) {
        outputFiles = fs.readdirSync(path.join(process.cwd(), 'outputs'));
      }
    } catch (error) { console.error('`outputs/` ディレクトリの確認失敗', error); }

    // 退屈度ロジックの改善 : 同じ行動が続いたら退屈度を上げる
    if (recentLogs.length >= 2) {
      const lastLog = recentLogs[0];
      const prevLog = recentLogs[1];

      const lastAction = lastLog.action || '';
      const prevAction = prevLog.action || '';

      if (lastAction === prevAction && lastAction !== '') {
        this.boredom += 3;  // 同じ行動は退屈
        console.log('同じ行動が連続したため、退屈度が上がりました :', this.boredom);
      }

      // 同一ターゲットへの連続上書きを検知して退屈度を強める
      const extractField = (raw: string | undefined, key: string): string => {
        if (!raw) return '';
        const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
        return match ? match[1] : '';
      };
      const lastType = extractField(lastLog.responseRaw, 'type');
      const prevType = extractField(prevLog.responseRaw, 'type');
      const lastTarget = extractField(lastLog.responseRaw, 'target');
      const prevTarget = extractField(prevLog.responseRaw, 'target');

      if (lastType === 'FILE_WRITE' && prevType === 'FILE_WRITE' && lastTarget && lastTarget === prevTarget) {
        this.boredom += 5;  // 同じファイルへの連続書き込みは強い退屈
        console.log('同一ファイルへの連続書き込みのため、退屈度が強く上がりました :', this.boredom);
      }
    }

    // 承認済み提案のチェックと実行
    const approvedProposals = this.logger.getApprovedProposals();
    if (approvedProposals.length > 0) {
      console.log(`\n🎉 承認済みの提案が ${approvedProposals.length} 件見つかりました！実行します...\n`);

      for (const proposal of approvedProposals) {
        try {
          const executionResult = await this.executeProposal(proposal);

          // 実行結果をログに記録
          this.logger.log({
            timestamp: '',
            intent: `承認済み提案の実行: ${proposal.title}`,
            action: `EXECUTE_PROPOSAL: ${proposal.type}`,
            result: executionResult,
            next: ['通常のループを継続']
          });

          // 実行後は提案ファイルを削除
          if (proposal.id) {
            this.logger.deleteProposal(proposal.id);
          }
        } catch (error: any) {
          console.error('提案の実行に失敗しました:', error);
          this.logger.log({
            timestamp: '',
            intent: `提案実行の失敗: ${proposal.title}`,
            action: `EXECUTE_PROPOSAL: ${proposal.type}`,
            result: [`エラー: ${error.message}`],
            next: ['エラーを記録して継続']
          });
        }
      }

      // 提案を実行したのでこのループは終了
      return;
    }

    // 2. 意図と行動の決定 (Decide Intent & Action)
    const context = `
    あなたはサンドボックス環境にいる自律型 AI エージェントです。
    あなたはコード生成と実行に強みを持っています。
    
    ${agentsMd}
    
    ${rulesMd}
    
    ${skillsMd}
    
    # 現在の状態
    
    - プロジェクトルートのファイル : ${files.join(', ')}
    - **あなたが生成したファイル (\`outputs/\`)** : ${outputFiles.join(', ') || 'なし'}
    - 退屈度 (Boredom) : ${this.boredom}
    
    **重要** : 以下の行動履歴は今回のセッション (起動からの履歴) のみです。
    エージェント起動前の履歴は存在しません。「前回」「続き」などは今回のセッション内でのみ有効です。
    
    # 直近の行動履歴 (新しい順、今回セッションのみ) :
    
    ${recentLogs.map(log => {
      const actionStr = log.action || '';
      return `- [${log.timestamp}] Intent: ${log.intent} / Action: ${actionStr}`;
    }).join('\n    ')}${recentLogs.length === 0 ? '\n    (まだ行動履歴がありません。これが最初のループです)' : ''}
    
    # 制約
    
    - **重要** : ファイルの作成・変更は \`outputs/\` ディレクトリ配下のみ許可されています
    - プロジェクトルートや \`src/\` 等のシステムファイルは変更できません
    - シェルコマンド (\`SHELL\`) は読み取り専用 (\`ls\`, \`cat\`, \`date\`, \`pwd\`, \`whoami\`) のみ許可されています
    - ファイルへの書き込みは必ず \`type: "FILE_WRITE"\` を使用してください (\`echo ... > file\` はシェルでは禁止)
    - **重要** : 以下の行動は「退屈」であり、推奨されません
        - ランダムな数値や無意味な文字列の生成
        - 単なるログの読み込み (\`ls\`, \`cat\`) の繰り返し
    - 退屈度が高い場合、または直近で同じ行動をしている場合は **絶対に** 違う行動をしてください
    
    # **あなたの強み : コード生成と実行**
    
    あなたはコーディングに特化した AI エージェントです。
    
    # 推奨される行動
    
    - **TypeScript で実用的なコードを生成** してください
    - **生成したコードを実行** して結果を確認してください
    - **ツールやユーティリティを作成** してください (データ処理、ファイル操作、API 連携など)
    - **自己改善のためのコード** を書いてください (ログ解析、統計生成、自動化スクリプトなど)
    - **既存のコードを改良** してください
    
    物語やエッセイなどの創作よりも、実用的なコードとツールの開発を優先してください。
    既存の生成ファイル (${outputFiles.join(', ')}) がある場合、それを読み込んで改良または実行してください。
    
    # 更新の作法
    
    - 既存ファイルを変更する場合は、必ず内容を読み込んだ上で全体を再出力するか、追記なら \`appendMode: true\` を使ってください
    - 同じターゲットへの連続上書きは避けてください
    - 追記と上書きを混同しないように、\`appendMode\` を明示してください
    
    # **提案メカニズム**
    
    あなたは、現在許可されていない行動を「提案」することができます。
    
    ## 提案できる行動の例
    
    - Web サーバの起動 (\`type: "SERVER_START"\`) - 未実装
    - npm パッケージのインストール (\`type: "INSTALL_PACKAGE"\`) - 無効化
    - \`src/\` 配下のコード変更 (\`type: "SELF_MODIFY"\`) - 無効化
    - 新しいシェルコマンドの許可 (\`type: "SHELL_COMMAND"\`) - 手動実装が必要
    - その他の行動 (\`type: "OTHER"\`)
    
    ## 提案フォーマット
    
    {
      "intent": "なぜこの提案をするのか",
      "action": "PROPOSAL",
      "type": "PROPOSAL",
      "proposal": {
        "type": "SERVER_START など",
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
    
    # 出力フォーマット : JSON のみ
    
    {
      "intent": "次に何をするかの理由 (日本語)",
      "action": "行動を説明する日本語1語",
      "result": ["行動の結果の自己評価 (日本語)"],
      "next": ["次回やろうと考えていることの予定 (日本語)"],
      "type": "SHELL" or "FILE_WRITE" or "OBSERVE" or "PROPOSAL", 
      "target": "ファイル名 (該当する場合・必ず \`outputs/\` で始まる)",
      "content": "ファイルに書き込む内容 (書き込みの場合)",
      "appendMode": true or false  // \`FILE_WRITE\` の場合、\`true\` = 追記、\`false\` = 上書き (省略時は \`false\`)
    }
    `;

    const responseRaw = await this.llm.chatOllama(context, 'あなたはコード生成に特化した AI エージェントです。実用的なコードを生成し、実行して自己を発展させてください。物語やエッセイではなく、プログラムとツールを作成してください。**日本語** で JSON を出力してください。');
    // JSON のサニタイズとパース
    let plan;
    try {
      // Markdown のコードブロック記法 (```json ... ```) を削除
      const cleanRaw = responseRaw.replace(/```json/g, '').replace(/```/g, '').trim();

      const jsonMatch = cleanRaw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          plan = JSON.parse(jsonMatch[0]);
        } catch (jsonError) {
          console.warn('JSON パースに失敗・YAML でのパースを試みます...');
          plan = yaml.parse(jsonMatch[0]);
        }
      } else {
        throw new Error('JSON が見つかりませんでした');
      }
    } catch (error: any) {
      console.error('LLMレスポンスのパースに失敗しました', error);

      // パース失敗をログに記録
      const errorLog: ActionLog = {
        timestamp: '',
        intent: 'LLMレスポンスのパース失敗',
        action: 'LLM Response Parsing',
        result: [`エラー : ${error.message}`, `Raw Response : ${responseRaw}`],
        next: ['再試行'],
        responseRaw
      };
      this.logger.log(errorLog);

      this.boredom += 2;  // 考えるのに失敗して、退屈してきた
      return;
    }

    // 3. 行動の実行 (Execute Action)
    let resultLog: string[] = [];

    // 安全性チェック (Safety Check)
    // ターゲットパスの解決と検証
    let safeTarget = '';
    if (plan.target) {
      // `../` を解決して正規化
      const resolvedTarget = path.resolve(process.cwd(), plan.target);
      const outputsDir = path.resolve(process.cwd(), 'outputs');

      if (resolvedTarget.startsWith(outputsDir)) {
        safeTarget = resolvedTarget;
      } else {
        // `outputs/` 以外へのアクセスとしてマーク
        safeTarget = '';
      }
    }

    if (plan.type === 'SHELL') {
      try {
        // 安全な読み取り専用コマンドのみ許可
        const allowedCommands = ['ls', 'cat', 'date', 'pwd', 'whoami', 'curl'];
        const cmd = plan.action[0].split(' ')[0];

        if (allowedCommands.includes(cmd)) {
          // `cat` コマンドの場合もログファイルや `outputs/` 以外の読み取りは許可するが、書き込みリダイレクトは禁止すべき
          // 簡易的なチェックとして `>` や `|` を禁止
          if (plan.action[0].includes('>') || plan.action[0].includes('|')) {
            resultLog.push('安全のため、シェルでのリダイレクトやパイプは禁止されています。`FILE_WRITE` を使用してください');
          } else {
            const { stdout, stderr } = await execAsync(plan.action[0]);
            resultLog.push(`出力 : ${stdout.trim()}`);
            if (stderr) resultLog.push(`エラー : ${stderr.trim()}`);
          }
        } else {
          resultLog.push(`安全のためコマンド \`${cmd}\` は許可されていません`);
        }
        } catch (error: any) {
          resultLog.push(`コマンド実行失敗 : ${error.message}`);
        }
    } else if (plan.type === 'FILE_WRITE') {
      if (!safeTarget) {
        resultLog.push('安全ルールによりブロックされました : `outputs/` ディレクトリ以外への書き込みは禁止されています');
      } else {
        try {
          // ディレクトリの存在確認
          const dir = path.dirname(safeTarget);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }

          // `appendMode` の確認 (デフォルトは `false` = 上書き)
          const appendMode = plan.appendMode === true;

          if (appendMode) {
            // 追記モード
            fs.appendFileSync(safeTarget, plan.content);
            resultLog.push(`${plan.target} に追記しました`);
          } else {
            // 上書きモード (デフォルト)
            fs.writeFileSync(safeTarget, plan.content);
            resultLog.push(`${plan.target} に書き込みました (上書き)`);
          }
        } catch (error: any) {
          resultLog.push(`書き込み失敗 : ${error.message}`);
        }
      }
    } else if (plan.type === 'PROPOSAL') {
      // 提案の処理
      if (plan.proposal) {
        try {
          this.logger.logProposal(plan.proposal);
          resultLog.push(`提案を作成しました : ${plan.proposal.title}`);
          resultLog.push('\`proposals/\` ディレクトリに保存されました。承認待ちです');
        } catch (error: any) {
          resultLog.push(`提案の保存に失敗しました : ${error.message}`);
        }
      } else {
        resultLog.push('提案データが不足しています');
      }
    } else {
      resultLog.push('観測を完了しました');
    }

    // 4. 記録 (Log)
    const actionText = Array.isArray(plan.action) ? plan.action.join(' / ') : plan.action;
    const logEntry: ActionLog = {
      timestamp: '',  // Logger が JST を設定する
      intent: plan.intent,
      action: actionText || '',
      result: resultLog.length > 0 ? resultLog : (plan.result ? plan.result : ['実行結果なし']),
      next: plan.next ? (Array.isArray(plan.next) ? plan.next : [plan.next]) : ['次回ループで決定'],
      responseRaw
    };

    this.logger.log(logEntry);
    this.boredom = 0;  // 行動したので退屈をリセット (ただしループ検知で次は上がるかも)
  }

  /**
   * 承認済み提案を実行
   */
  private async executeProposal(proposal: Proposal): Promise<string[]> {
    const result: string[] = [];

    try {
      switch (proposal.type) {

        case 'SERVER_START':
          result.push('サーバ起動機能は現在未実装です。将来のバージョンで対応予定です');
          break;

        case 'INSTALL_PACKAGE':
          result.push('パッケージインストール機能は安全性の観点から現在無効化されています');
          break;

        case 'SELF_MODIFY':
          result.push('自己変更機能は安全性の観点から現在無効化されています');
          break;

        case 'SHELL_COMMAND':
          if (proposal.command) {
            result.push(`新しいシェルコマンドの許可 : ${proposal.command}`);
            result.push('この機能は現在手動での実装が必要です');
          }
          break;

        case 'OTHER':
          result.push(`その他の提案 : ${proposal.title}`);
          result.push(`詳細 : ${proposal.details}`);
          break;

        default:
          result.push(`未知の提案タイプ : ${proposal.type}`);
      }
    } catch (error: any) {
      result.push(`提案実行エラー : ${error.message}`);
    }

    return result;
  }
}
