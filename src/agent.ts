import { LLMClient } from './llm.js';
import { Logger } from './logger.js';
import { ActionLog, Proposal, Plan } from './types.js';
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
  private statePath: string;

  constructor() {
    this.llm = new LLMClient();
    this.logger = new Logger();
    this.statePath = path.join(process.cwd(), 'outputs', 'state.yaml');
  }

  public async start() {
    console.log('エージェントを開始しました。停止するには Ctrl+C を押してください');

    process.on('SIGINT', async () => {
      console.log('\nSIGINT を受信しました。停止します...');
      this.isRunning = false;
      this.logger.log({
        timestamp: '',  // Logger 側で現在時刻 (JST) が設定されます
        intent: 'システムが SIGINT による即時停止を要求しました',
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
    const allowedTypes = new Set(['SHELL', 'FILE_WRITE', 'PROPOSAL']);
    const allowedShellCommands = ['ls', 'cat', 'date', 'pwd', 'whoami', 'curl'];

    // MD ファイルの読み込み
    let agentsMd = '', rulesMd = '', skillsMd = '';
    try {
      agentsMd = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8');
      rulesMd = fs.readFileSync(path.join(process.cwd(), 'RULES.md'), 'utf-8');
      skillsMd = fs.readFileSync(path.join(process.cwd(), 'SKILLS.md'), 'utf-8');
    } catch (error) {
      console.error('MD ファイルの読み込みに失敗しました', error);
    }

    // `outputs/` ディレクトリ内のファイル一覧を取得 (生成物の把握)
    let outputFiles: string[] = [];
    try {
      if (fs.existsSync(path.join(process.cwd(), 'outputs'))) {
        outputFiles = fs.readdirSync(path.join(process.cwd(), 'outputs'));
      }
    } catch (error) { console.error('`outputs/` ディレクトリの確認失敗', error); }

    // 永続状態の読み込み (存在しない場合は空で OK)
    let stateSummary = 'なし';
    let stateObj: any = null;
    try {
      if (fs.existsSync(this.statePath)) {
        const stateRaw = fs.readFileSync(this.statePath, 'utf-8');
        stateObj = yaml.parse(stateRaw);
        stateSummary = yaml.stringify(stateObj).trim() || 'なし';
      }
    } catch (error) {
      console.error('state.yaml の読み込みに失敗しました', error);
      stateSummary = '読み込み失敗';
    }
    if (stateSummary.length > 2000) {
      stateSummary = stateSummary.slice(0, 2000) + '...';
    }

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
            intent: `承認済み提案の実行 : ${proposal.title}`,
            action: `EXECUTE_PROPOSAL : ${proposal.type}`,
            result: executionResult,
            next: ['通常のループを継続']
          });

          // 実行後は提案ファイルを削除
          if (proposal.id) {
            this.logger.deleteProposal(proposal.id);
          }
        } catch (error: any) {
          console.error('提案の実行に失敗しました', error);
          this.logger.log({
            timestamp: '',
            intent: `提案実行の失敗 : ${proposal.title}`,
            action: `EXECUTE_PROPOSAL : ${proposal.type}`,
            result: [`エラー : ${error.message}`],
            next: ['エラーを記録して継続']
          });
        }
      }

      // 提案を実行したのでこのループは終了
      return;
    }

    // 2. 意図と行動の決定 (Decide Intent & Action)
    const context = `
    あなたはサンドボックス環境で動作する自律型 AI エージェントです。コード生成に強みがあります。
    
    ${agentsMd}
    
    ${rulesMd}
    
    ${skillsMd}
    
    # 現在の状態 (客観情報)
    
    - プロジェクトルートのファイル : ${files.join(', ')}
    - outputs/ の生成物 : ${outputFiles.join(', ') || 'なし'}
    - 永続状態 (outputs/state.yaml) : ${stateSummary}
    - 退屈度 (Boredom) : ${this.boredom}
    
    # 直近の行動履歴 (新しい順)
    
    ${recentLogs.map(log => {
      const actionStr = log.action || '';
      return `- [${log.timestamp}] Intent: ${log.intent} / Action: ${actionStr}`;
    }).join('\n    ')}${recentLogs.length === 0 ? '\n    (まだ行動履歴がありません。これが最初のループです)' : ''}
    
    # 制約 (最優先)
    
    - 変更・作成は outputs/ 配下のみ
    - src/ などシステムファイルは変更不可
    - SHELL で許可されるコマンド : ls, cat, date, pwd, whoami, curl
    - リダイレクトやパイプは禁止
    
    # できる行動
    
    - SHELL : 読み取りや状態確認 (例: ls, cat)
    - FILE_WRITE : outputs/ 配下への作成・更新
    - PROPOSAL : 実行や許可が必要な行動の提案
    
    # 行動のルール
    
    - 既存ファイルを更新する前に必ず cat で内容を読む
    - コード実行はこのシステムでは禁止。実行したい場合は PROPOSAL を出す
    - action は日本語の作業概要を1行で書く (英単語・システム語は禁止)
    - 観測は SHELL で行う (OBSERVE は使わない)
    
    # 目標
    
    - 実用的な TypeScript ツールやユーティリティを作る
    - 既存コードがある場合は読み取り→改良を優先する
    
    # 提案の書き方
    
    - 提案は「何を承認してほしいか」が具体的に分かる内容にする
    - CODE_EXECUTE の場合は targetFile と command を必ず含める
    
    # 出力形式
    
    - JSON 以外は出力しない
    - コードブロックや説明文は禁止
    - 使わないフィールドは省略してよい
    
    出力は次の JSON 形式に従うこと。
    
    {
      "intent": "次に何をするかの理由",
      "action": "行動の概要を日本語1行で記述",
      "result": ["行動の結果の自己評価"],
      "next": ["次回やろうと考えていることの予定"],
      "type": "SHELL",
      "command": "ls -la"
    }
    `;

    const systemPrompt = 'あなたはコード生成に特化した AI エージェントです。実用的なコードを生成し、実行して自己を発展させてください。物語やエッセイではなく、プログラムとツールを作成してください。**日本語** で JSON を出力してください。';

    const parsePlan = (raw: string): any => {
      const cleanRaw = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const jsonMatch = cleanRaw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('JSON が見つかりませんでした');
      }
      // まず JSON として厳格にパースする
      return JSON.parse(jsonMatch[0]);
    };

    const responseRaw = await this.llm.chatOllama(context, systemPrompt);
    // JSON のサニタイズとパース
    let plan: Plan | any;
    try {
      plan = parsePlan(responseRaw);
    } catch (error: any) {
      console.error('LLM レスポンスのパースに失敗しました', error);
      try {
        const strictPrompt = `
以下の出力は JSON ではありません。**厳密な JSON のみ** を出力してください。
説明文・コードブロック・余計な文字は一切禁止です。

# 出力フォーマット

{
  "intent": "...",
  "action": "...",
  "result": ["..."],
  "next": ["..."],
  "type": "SHELL" or "FILE_WRITE" or "PROPOSAL",
  "target": "...",
  "content": "...",
  "command": "...",
  "appendMode": true or false,
  "state": { "goal": "...", "milestones": ["..."], "progress": "...", "nextFocus": "...", "blockers": ["..."] }
}

# 元の出力

${responseRaw}
        `.trim();
        const repairedRaw = await this.llm.chatOllama(strictPrompt, systemPrompt);
        plan = parsePlan(repairedRaw);
      } catch (repairError: any) {
        // パース失敗をログに記録
        const errorLog: ActionLog = {
          timestamp: '',
          intent: 'LLMレスポンスのパース失敗',
          action: 'LLM Response Parsing',
          result: [`エラー : ${repairError.message}`, `Raw Response : ${responseRaw}`],
          next: ['再試行'],
          responseRaw
        };
        this.logger.log(errorLog);
        this.boredom += 2;
        return;
      }
    }

    const validatePlan = (candidate: any): string[] => {
      const errors: string[] = [];
      if (!candidate || typeof candidate !== 'object') {
        errors.push('plan がオブジェクトではありません');
        return errors;
      }
      if (!candidate.type || !allowedTypes.has(candidate.type)) {
        errors.push(`type が不正です: ${candidate.type}`);
      }
      if (candidate.type === 'FILE_READ') {
        errors.push('FILE_READ は無効です (SHELL の cat を使ってください)');
      }
      const actionText = Array.isArray(candidate.action) ? candidate.action.join(' / ') : candidate.action;
      if (!actionText || typeof actionText !== 'string') {
        errors.push('action が文字列ではありません');
      }
      if (candidate.type === 'SHELL') {
        const rawCommand = candidate.command || (Array.isArray(candidate.action) ? candidate.action[0] : candidate.action);
        const cmd = (rawCommand || '').split(' ')[0];
        if (!allowedShellCommands.includes(cmd)) {
          errors.push(`SHELL の command が許可コマンドではありません : ${cmd}`);
        }
      }
      if (candidate.type === 'PROPOSAL') {
        if (!candidate.proposal || typeof candidate.proposal !== 'object') {
          errors.push('proposal がありません');
        } else {
          const p = candidate.proposal;
          if (!p.type || !p.title || !p.reasoning || !p.details) {
            errors.push('proposal の必須項目 (type/title/reasoning/details) が不足しています');
          }
          if (p.title && p.reasoning && p.title === p.reasoning) {
            errors.push('proposal.title と reasoning が同一です');
          }
          if (p.details && p.reasoning && p.details === p.reasoning) {
            errors.push('proposal.details が reasoning と同一です');
          }
          if (p.details && typeof p.details === 'string' && p.details.trim().length < 15) {
            errors.push('proposal.details が具体的ではありません');
          }
          if (!Array.isArray(p.risks) || p.risks.length === 0) {
            errors.push('proposal.risks が不足しています');
          }
          if (!Array.isArray(p.benefits) || p.benefits.length === 0) {
            errors.push('proposal.benefits が不足しています');
          }
          if (p.type === 'CODE_EXECUTE') {
            if (!p.targetFile) {
              errors.push('CODE_EXECUTE の targetFile がありません');
            }
            if (!p.command) {
              errors.push('CODE_EXECUTE の command がありません');
            }
            if (p.targetFile) {
              const resolved = path.resolve(process.cwd(), p.targetFile);
              const outputsDir = path.resolve(process.cwd(), 'outputs');
              if (!resolved.startsWith(outputsDir) || !fs.existsSync(resolved)) {
                errors.push('CODE_EXECUTE の targetFile が存在しません');
              }
            }
          }
        }
      }
      if (candidate.type === 'FILE_WRITE' && candidate.target) {
        const resolvedTarget = path.resolve(process.cwd(), candidate.target);
        const outputsDir = path.resolve(process.cwd(), 'outputs');
        if (resolvedTarget.startsWith(outputsDir) && fs.existsSync(resolvedTarget)) {
          const needle = `cat ${candidate.target}`;
          const readRecently = recentLogs.some(log => (log.responseRaw || '').includes(needle));
          if (!readRecently) {
            errors.push('既存ファイルを読み取らずに上書きしようとしています');
          }
        }
      }
      return errors;
    };

    let planErrors = validatePlan(plan);
    if (planErrors.length > 0) {
      try {
        const repairPrompt = `
以下の JSON は制約に違反しています。**正しい JSON のみ** を出力してください。

# エラー

${planErrors.map(e => `- ${e}`).join('\n')}

# 制約

- type は "SHELL" / "FILE_WRITE" / "PROPOSAL" のいずれか
- action は日本語での作業概要 (英単語や FILE_READ などは禁止)
- ファイル読み取りは SHELL の cat を使う (FILE_READ は存在しない)
- コマンド実行は PROPOSAL (type: CODE_EXECUTE, targetFile: outputs/...) で提案する
- SHELL の command は許可コマンドから開始する : ${allowedShellCommands.join(', ')}

# 元の JSON

${responseRaw}
        `.trim();
        const repairedRaw = await this.llm.chatOllama(repairPrompt, systemPrompt);
        plan = parsePlan(repairedRaw);
        planErrors = validatePlan(plan);
        if (planErrors.length > 0) {
          throw new Error(`修正後も不正 : ${planErrors.join(' / ')}`);
        }
      } catch (error: any) {
        console.error('修正プロンプトの結果が不正でした', error);
        const errorLog: ActionLog = {
          timestamp: '',
          intent: 'LLM レスポンスの再修正失敗',
          action: '修正失敗',
          result: [`エラー : ${error.message}`],
          next: ['再試行'],
          responseRaw
        };
        this.logger.log(errorLog);
        this.boredom += 2;
        return;
      }
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

    if (!allowedTypes.has(plan.type)) {
      resultLog.push(`未対応の行動タイプが指定されました : ${plan.type}`);
      resultLog.push('実行は行われませんでした');
    } else if (plan.type === 'SHELL') {
      try {
        // 安全な読み取り専用コマンドのみ許可
        const rawCommand = plan.command || (Array.isArray(plan.action) ? plan.action[0] : plan.action);
        const cmd = (rawCommand || '').split(' ')[0];

        if (allowedShellCommands.includes(cmd)) {
          // `cat` コマンドの場合もログファイルや `outputs/` 以外の読み取りは許可するが、書き込みリダイレクトは禁止すべき
          // 簡易的なチェックとして `>` や `|` を禁止
          if ((rawCommand || '').includes('>') || (rawCommand || '').includes('|')) {
            resultLog.push('安全のため、シェルでのリダイレクトやパイプは禁止されています。`FILE_WRITE` を使用してください');
          } else {
            const { stdout, stderr } = await execAsync(rawCommand);
            const output = stdout.trim();

            if (cmd === 'curl') {
              const ts = new Date().toISOString().replace(/[:.]/g, '-');
              const curlOut = path.join(process.cwd(), 'outputs', `curl_response_${ts}.txt`);
              const dir = path.dirname(curlOut);
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
              }
              fs.writeFileSync(curlOut, output, 'utf-8');
              resultLog.push(`curl のレスポンスを保存しました : \`outputs/${path.basename(curlOut)}\``);
            }

            if (output) {
              resultLog.push(`出力 : ${output}`);
            } else {
              resultLog.push('出力は空でした');
            }
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
          resultLog.push('`proposals/` ディレクトリに保存されました。承認待ちです');
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
    const actionText = (Array.isArray(plan.action) ? plan.action.join(' / ') : plan.action) || '不明';
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

    // 永続状態の更新
    try {
      const nextList = logEntry.next || [];
      const existing = stateObj && typeof stateObj === 'object' ? stateObj : {};
      const history = Array.isArray(existing.history) ? existing.history : [];

      history.push({
        timestamp: new Date().toISOString(),
        action: actionText || '',
        result: resultLog.length > 0 ? resultLog : (plan.result ? plan.result : [])
      });
      if (history.length > 20) {
        history.splice(0, history.length - 20);
      }

      const plannedState = plan.state && typeof plan.state === 'object' ? plan.state : {};
      const sanitizeGoalText = (text: string | undefined): string => {
        if (!text) return '';
        if (text.includes('退屈')) return '';
        return text;
      };
      const state = {
        goal: sanitizeGoalText(plannedState.goal) || sanitizeGoalText(existing.goal) || sanitizeGoalText(plan.intent) || '',
        milestones: plannedState.milestones || existing.milestones || [],
        progress: plannedState.progress || existing.progress || '',
        nextFocus: sanitizeGoalText(plannedState.nextFocus) || sanitizeGoalText(existing.nextFocus) || '',
        blockers: plannedState.blockers || existing.blockers || [],
        lastAction: actionText || '',
        lastResult: resultLog.length > 0 ? resultLog : (plan.result ? plan.result : []),
        next: nextList,
        history,
        updatedAt: new Date().toISOString()
      };

      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.statePath, yaml.stringify(state), 'utf-8');
    } catch (error) {
      console.error('state.yaml の書き込みに失敗しました', error);
    }
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
