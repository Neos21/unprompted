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

  public log(data: ActionLog): string {
    const now = new Date();
    const toJST = (date: Date) => {
      const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
      return jstDate.toISOString().replace('Z', '').replace('T', ' ');
    };

    const timestampJST = toJST(now);
    if (!data.timestamp || data.timestamp.endsWith('Z')) {
      data.timestamp = timestampJST;
    }

    if (data.proposal) {
      console.log('==============================');
      console.log('   新しい提案があります！');
      console.log('==============================');
      console.log(`タイトル : ${data.proposal.title}`);
      console.log(`種類 : ${data.proposal.type}`);
      console.log(`理由 : ${data.proposal.reasoning}`);
      console.log(`詳細 : ${data.proposal.details}`);
      console.log(`リスク : ${data.proposal.risks}`);
      console.log(`利益 : ${data.proposal.benefits}`);
      console.log('承認する場合は `proposals/` 内の YAML ファイルに `approved: true` を追記してください');
      console.log('==============================');
    }

    const filename = timestampJST.replace(/:/g, '-').replace('.', '-') + '.yaml';
    const filepath = path.join(this.logDir, filename);

    const logContent = yaml.stringify(data);

    console.log('--- ログ出力 ---');
    console.log(logContent);
    console.log('----------------');

    fs.writeFileSync(filepath, logContent, 'utf8');

    return filepath;
  }

  public logProposal(proposal: Proposal): string {
    const now = new Date();
    const toJST = (date: Date) => {
      const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
      return jstDate.toISOString().replace('Z', '').replace('T', ' ');
    };

    const timestampJST = toJST(now);
    if (!proposal.timestamp) {
      proposal.timestamp = timestampJST;
    }

    const filename = timestampJST.replace(/:/g, '-').replace(/ /g, '_').replace('.', '-') + `_${proposal.type}.yaml`;
    proposal.id = filename.replace('.yaml', '');
    if (proposal.approved === undefined) {
      proposal.approved = false;
    }

    const filepath = path.join(this.proposalDir, filename);

    const proposalContent = yaml.stringify(proposal);
    fs.writeFileSync(filepath, proposalContent, 'utf8');

    console.log(`提案を保存しました : ${filepath}`);

    return filepath;
  }

  public getApprovedProposals(): Proposal[] {
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

        const approvedFlag = (proposal && (proposal.approved === true || (proposal as any).approve === true));
        if (approvedFlag) {
          proposal.approved = true;
          proposal.id = file.replace('.yaml', '');
          approvedProposals.push(proposal);
        }
      } catch (error) {
        console.error(`提案ファイル ${file} のパースに失敗しました`, error);
      }
    }

    return approvedProposals;
  }

  public deleteProposal(proposalId: string): void {
    const filepath = path.join(this.proposalDir, proposalId + '.yaml');
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      console.log(`提案を削除しました : ${filepath}`);
    }
  }

  public getRecentLogs(limit: number): ActionLog[] {
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
      } catch (error) {
        console.error(`ログファイル ${file} のパースに失敗しました`, error);
      }
    }
    return logs;
  }
}
