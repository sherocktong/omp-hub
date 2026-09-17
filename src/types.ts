export interface Profile {
  provider?: string;
  model?: string;
  models?: string[];
  thinking?: string;
  token?: string;
  url?: string;
  /** Arbitrary config.yml overrides, merged over the source agent config.
   *  A null value deletes the key from the materialized config.yml. */
  settings?: Record<string, unknown>;
}

export interface ProfilesData {
  profiles: Record<string, Profile>;
  default?: string;
}

export interface AgentConfigData {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  [key: string]: unknown;
}

export interface ModelsFileData {
  providers: Record<string, { baseUrl?: string; [key: string]: unknown }>;
}

// Known omp provider ids (from `omp --help` env-var reference and provider
// registry). Warn-only: unknown ids are allowed because omp supports custom
// providers via models.yml.
export const OMP_PROVIDERS: string[] = [
  "anthropic",
  "openai",
  "openai-codex",
  "gemini",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "amazon-bedrock",
  "azure-openai",
  "deepseek",
  "deepinfra",
  "kimi",
  "kimi-code",
  "moonshot",
  "qwen-portal",
  "alibaba-coding-plan",
  "alibaba-token-plan",
  "mistral",
  "groq",
  "cerebras",
  "xai",
  "openrouter",
  "kilo",
  "zai",
  "minimax",
  "umans",
  "abliteration",
  "opencode",
  "opencode-zen",
  "opencode-go",
  "cursor",
  "cline",
  "command-code",
  "charm",
  "vercel-ai-gateway",
  "wafer",
  "yolo-auto",
  "github-copilot",
  "novita",
  "venice",
  "nanogpt",
  "fireworks",
  "ollama",
  "nvidia",
  "together",
  "huggingface",
];

export const THINKING_LEVELS: string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
];

// Maps an omp provider id to the env var omp reads an API key from. Used to
// inject a profile's token at launch time (omp v18 stores credentials in the
// per-agent-dir agent.db, which a fresh profile dir doesn't have, so env vars
// are honoured). Providers absent here fall back to the normalized
// `<PROVIDER>_API_KEY` form.
export const PROVIDER_TOKEN_ENV: Record<string, string> = {
  "kimi-code": "KIMI_API_KEY",
  "kimi": "KIMI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  google: "GEMINI_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  "azure-openai": "AZURE_OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  kilo: "KILO_API_KEY",
  mistral: "MISTRAL_API_KEY",
  zai: "ZAI_API_KEY",
  umans: "UMANS_AI_CODING_PLAN_API_KEY",
  abliteration: "ABLITERATION_API_KEY",
  minimax: "MINIMAX_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-zen": "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  cursor: "CURSOR_ACCESS_TOKEN",
  cline: "CLINE_API_KEY",
  "command-code": "COMMAND_CODE_API_KEY",
  charm: "CHARM_HYPER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  wafer: "WAFER_SERVERLESS_API_KEY",
  "yolo-auto": "YOLO_AUTO_API_KEY",
  deepinfra: "DEEPINFRA_API_KEY",
  "qwen-portal": "QWEN_PORTAL_API_KEY",
  "alibaba-coding-plan": "ALIBABA_CODING_PLAN_API_KEY",
  "alibaba-token-plan": "ALIBABA_TOKEN_PLAN_API_KEY",
};

/** Env var omp reads this provider's API key from, with a normalized fallback. */
export function providerTokenEnvVar(provider: string): string {
  return PROVIDER_TOKEN_ENV[provider] || provider.toUpperCase().replace(/-/g, "_") + "_API_KEY";
}

/** Providers whose token omp ignores from the environment — they only accept
 * it via the `--api-key` launch flag (their auth is OAuth-first; e.g. kimi-code
 * rejects env-var keys client-side with 401 before any request is sent). For
 * these, the runner passes `--api-key <token>` (omp requires an explicit
 * `--model` whenever `--api-key` is given, so the profile's first model is
 * passed too). Note: the token is briefly visible in the child process's argv. */
export const PROVIDER_API_KEY_ARG: ReadonlySet<string> = new Set(["kimi-code"]);
