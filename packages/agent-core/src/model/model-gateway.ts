export type ApiKeyResolver = (provider: string) => string | undefined | Promise<string | undefined>;

export type ModelGatewayOptions = {
  resolveApiKey: ApiKeyResolver;
  onApiKeyResolved?: () => void;
};

export class ModelGateway {
  constructor(private readonly options: ModelGatewayOptions) {}

  async getApiKey(provider: string) {
    const key = await this.options.resolveApiKey(provider);
    if (key) this.options.onApiKeyResolved?.();
    return key;
  }
}

