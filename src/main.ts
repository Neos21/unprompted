
import { Agent } from './agent.js';
import dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const apiKey = process.env.GEMINI_API_KEY;

const agent = new Agent(apiKey);

(async () => {
  try {
    await agent.start();
  } catch (error) {
    console.error("致命的なエラー:", error);
    process.exit(1);
  }
})();
