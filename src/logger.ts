
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { ActionLog, Proposal } from './types.js';

export class Logger {
  private logDir: string;
  private proposalDir: string;

  constructor(baseDir: string = process.cwd()) {
    this.logDir = path.join(baseDir, 'logs');
    this.proposalDir = path.join(baseDir, 'proposals');

    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    if (!fs.existsSync(this.proposalDir)) {
      fs.mkdirSync(this.proposalDir, { recursive: true });
    }
  }

  log(data: ActionLog): string {
    const now = new Date();
    // JSTのオフセットは+9時間です。
    // date.toISOString() はUTCを返すため、手動でJSTに変換してフォーマットします。
    const toJST = (date: Date) => {
      // JSTに調整
      const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
      return jstDate.toISOString().replace('Z', '').replace('T', ' ');
    };

    const timestampJST = toJST(now);
    // data.timestamp が空、またはUTC形式(Zで終わる)の場合はJSTを設定
    if (!data.timestamp || data.timestamp.endsWith('Z')) {
      data.timestamp = timestampJST;
    }

    // 提案がある場合は特別な表示
    if (data.proposal) {
      console.log("\n🔔 ==============================");
      console.log("   新しい提案があります！");
      console.log("==============================");
      console.log(`タイトル: ${data.proposal.title}`);
      console.log(`種類: ${data.proposal.type}`);
      console.log(`理由: ${data.proposal.reasoning}`);
      console.log(`詳細: ${data.proposal.details}`);
      console.log(`リスク: ${data.proposal.risks.join(', ')}`);
      console.log(`利益: ${data.proposal.benefits.join(', ')}`);
      console.log("\n承認する場合は proposals/ 内のYAMLファイルに 'approved: true' を追記してください。");
      console.log("==============================\n");
    }

    // ファイル名: YYYY-MM-DD HH-mm-SS-sss.yaml
    const filename = timestampJST.replace(/:/g, '-').replace('.', '-') + '.yaml';

    const filepath = path.join(this.logDir, filename);

    const logContent = yaml.stringify(data);

    // コンソールにも出力 (ユーザー要望)
    console.log("\n--- ログ出力 ---");
    console.log(logContent);
    console.log("----------------\n");

    fs.writeFileSync(filepath, logContent, 'utf8');

    return filepath;
  }

  /**
   * 提案を proposals/ ディレクトリに保存
   */
  logProposal(proposal: Proposal): string {
    const now = new Date();
    const toJST = (date: Date) => {
      const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
      return jstDate.toISOString().replace('Z', '').replace('T', ' ');
    };

    const timestampJST = toJST(now);
    if (!proposal.timestamp) {
      proposal.timestamp = timestampJST;
    }

    // ファイル名: YYYY-MM-DD_HH-mm-SS-sss_<type>.yaml
    const filename = timestampJST.replace(/:/g, '-').replace(/ /g, '_').replace('.', '-') + `_${proposal.type}.yaml`;
    proposal.id = filename.replace('.yaml', '');

    const filepath = path.join(this.proposalDir, filename);

    const proposalContent = yaml.stringify(proposal);
    fs.writeFileSync(filepath, proposalContent, 'utf8');

    console.log(`\n✅ 提案を保存しました: ${filepath}\n`);

    return filepath;
  }

  /**
   * 承認済みの提案を取得
   */
  getApprovedProposals(): Proposal[] {
    if (!fs.existsSync(this.proposalDir)) {
      return [];
    }

    const files = fs.readdirSync(this.proposalDir);
    const approvedProposals: Proposal[] = [];

    for (const file of files) {
      if (!file.endsWith('.yaml')) continue;

      try {
        const content = fs.readFileSync(path.join(this.proposalDir, file), 'utf8');
        const proposal = yaml.parse(content) as Proposal;

        if (proposal && proposal.approved === true) {
          proposal.id = file.replace('.yaml', '');
          approvedProposals.push(proposal);
        }
      } catch (e) {
        console.error(`提案ファイル ${file} のパースに失敗しました:`, e);
      }
    }

    return approvedProposals;
  }

  /**
   * 提案を削除（実行後）
   */
  deleteProposal(proposalId: string): void {
    const filepath = path.join(this.proposalDir, proposalId + '.yaml');
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      console.log(`提案を削除しました: ${filepath}`);
    }
  }

  getLastLog(): ActionLog | null {
    const logs = this.getRecentLogs(1);
    return logs.length > 0 ? logs[0] : null;
  }

  getRecentLogs(limit: number): ActionLog[] {
    if (!fs.existsSync(this.logDir)) {
      return [];
    }

    const files = fs.readdirSync(this.logDir).filter(f => f.endsWith('.yaml')).sort().reverse();
    if (files.length === 0) return [];

    const recentFiles = files.slice(0, limit);
    const logs: ActionLog[] = [];

    for (const file of recentFiles) {
      try {
        const content = fs.readFileSync(path.join(this.logDir, file), 'utf8');
        const log = yaml.parse(content) as ActionLog;
        if (log) logs.push(log);
      } catch (e) {
        console.error(`ログファイル ${file} のパースに失敗しました:`, e);
      }
    }
    return logs;
  }
}
