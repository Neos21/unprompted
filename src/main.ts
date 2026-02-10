import { Agent } from './agent.js';

(async () => {
  try {
    const agent = new Agent();
    await agent.start();
  } catch (error) {
    console.error('致命的なエラー', error);
    process.exit(1);
  }
})();
