
import ollama from 'ollama';

export class LLMClient {
  private ollamaModel: string;

  constructor(ollamaModel: string = 'qwen2.5-coder:7b') {
    this.ollamaModel = ollamaModel;
  }

  public async chatOllama(prompt: string, systemPrompt?: string): Promise<string> {
    try {
      const response = await ollama.chat({
        model: this.ollamaModel,
        messages: [
          { role: 'system', content: systemPrompt || '' },
          { role: 'user', content: prompt }
        ],
        stream: false,
        options: {
          num_ctx: 8192
        }
      });
      return response.message.content;
    } catch (error) {
      console.error('Ollama エラー', error);
      return '';
    }
  }
}
