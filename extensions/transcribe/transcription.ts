import { TranscribeModel } from "transcribe-cpp";
import { convertChineseOutput, isChineseLanguage } from "./chinese.js";
import type { ChineseOutput } from "./settings.js";

export interface TranscriptionBackend {
  prepare(): Promise<void>;
  transcribe(pcm: Float32Array, signal?: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

/** Local transcribe.cpp backend. A future IPC backend can implement the same small contract. */
export class TranscribeCppBackend implements TranscriptionBackend {
  private model: TranscribeModel | undefined;
  private loading: Promise<TranscribeModel> | undefined;
  private disposed = false;

  constructor(
    private readonly modelPath: string,
    private readonly language?: string,
    private readonly chineseOutput: ChineseOutput = "simplified",
  ) {}

  async prepare(): Promise<void> {
    if (this.model) return;
    if (this.disposed) throw new Error("Transcription backend has been disposed");

    if (!this.loading) {
      this.loading = TranscribeModel.load(this.modelPath).then((model) => {
        if (this.disposed) {
          model.dispose();
          throw new Error("Transcription backend was disposed while loading");
        }
        if (
          this.language &&
          !model.capabilities.languages.includes(this.language)
        ) {
          model.dispose();
          throw new Error(
            `Configured language ${this.language} is not supported by this model. Open /transcribe and choose another language.`,
          );
        }
        this.model = model;
        return model;
      });
    }

    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  async transcribe(pcm: Float32Array, signal?: AbortSignal): Promise<string> {
    if (pcm.length === 0) throw new Error("No microphone samples were captured");
    await this.prepare();
    const result = await this.model!.transcribe(pcm, {
      signal,
      timestamps: "none",
      ...(this.language ? { language: this.language } : {}),
    });
    const text = result.text.trim();
    return isChineseLanguage(result.language || this.language || "")
      ? convertChineseOutput(text, this.chineseOutput)
      : text;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.loading?.catch(() => undefined);
    this.model?.dispose();
    this.model = undefined;
  }
}
