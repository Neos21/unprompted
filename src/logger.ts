
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { ActionLog } from './types.js';

export class Logger {
  private logDir: string;

  constructor(baseDir: string = process.cwd()) {
    this.logDir = path.join(baseDir, 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  log(data: ActionLog): string {
    const now = new Date();
    // JST offset is +9 hours. 
    // However, toISOString() returns UTC. We want JST.
    // A simple way to get YYYY-MM-DD HH:mm:SS.sss in JST is to manually format
    const toJST = (date: Date) => {
      // Adjust to JST
      const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
      return jstDate.toISOString().replace('Z', '').replace('T', ' ');
    };

    const timestampJST = toJST(now);
    // data.timestamp should also be JST if not already or if it's new
    if (!data.timestamp || data.timestamp.endsWith('Z')) {
      data.timestamp = timestampJST;
    }

    // Filename: YYYY-MM-DD HH-mm-SS-sss.yaml
    // Format: 2026-02-10 12:28:35.001 -> 2026-02-10 12-28-35-001.yaml
    const filename = timestampJST.replace(/:/g, '-').replace('.', '-') + '.yaml';

    const filepath = path.join(this.logDir, filename);

    const logContent = yaml.stringify(data);
    fs.writeFileSync(filepath, logContent, 'utf8');

    return filepath;
  }

  getLastLog(): ActionLog | null {
    const files = fs.readdirSync(this.logDir).sort().reverse();
    if (files.length === 0) return null;

    const lastFile = files[0];
    const content = fs.readFileSync(path.join(this.logDir, lastFile), 'utf8');
    try {
      return yaml.parse(content) as ActionLog;
    } catch (e) {
      console.error("Failed to parse last log:", e);
      return null;
    }
  }
}
