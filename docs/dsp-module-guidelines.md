# DSP module guidelines (V1)

## Contrato C++ mínimo

```cpp
struct ModuleProcessContext {
    float** inputs;
    float** outputs;
    unsigned int numInputs;
    unsigned int numOutputs;
    unsigned int frames;
    float sampleRate;
};

struct ModuleMetricsInfo {
    const char* type;
    size_t stateBytes;
    size_t bufferBytes;
    bool usesDelayBuffer;
    const char* costClass;
};

class IAudioModule {
public:
    virtual ~IAudioModule() {}

    virtual const char* GetId() const = 0;
    virtual const char* GetType() const = 0;

    virtual void Prepare(float sampleRate, unsigned int maxBlockSize) = 0;
    virtual void Reset() = 0;
    virtual void SetEnabled(bool enabled) = 0;
    virtual void SetBypass(bool bypass) = 0;
    virtual void SetMix(float mix) = 0;

    virtual bool SetParamFloat(const char* paramId, float value) = 0;
    virtual bool SetParamInt(const char* paramId, int value) = 0;
    virtual bool SetParamBool(const char* paramId, bool value) = 0;
    virtual bool SetParamEnum(const char* paramId, const char* value) = 0;

    virtual void Process(const ModuleProcessContext& ctx) = 0;
    virtual ModuleMetricsInfo GetMetricsInfo() const = 0;
};
```

## Regras de implementação

- processar estéreo por padrão;
- aceitar `Prepare()` no init e se sample rate mudar;
- suportar `Reset()` em troca de patch/fonte;
- implementar bypass sem alocação por callback;
- evitar alocação dinâmica dentro de `Process()`;
- usar buffers temporários pré-alocados quando necessário.

## PatchEngine serial

Estratégia:

1. copiar entrada para `tempA`;
2. cada módulo lê de um buffer e escreve no outro;
3. alternar `tempA`/`tempB` por etapa;
4. copiar buffer final para saída.

Isso reduz custo e evita alocações por callback.

## Métricas sugeridas

```ts
export interface EngineMetrics {
  sampleRate: number;
  blockSize: number;
  baseLatency?: number;
  callbackMsAvg: number;
  callbackMsPeak: number;
  cpuLoadApprox?: number;
  modulesActive: number;
  memoryBytesEstimated: number;
  moduleBreakdown: Array<{
    id: string;
    type: string;
    stateBytes: number;
    bufferBytes: number;
    costClass: 'low' | 'medium' | 'high';
  }>;
}
```

Fórmulas:

- `budgetMs = (blockSize / sampleRate) * 1000`
- `cpuLoadApprox = callbackMsAvg / budgetMs`
- `memoryBytesEstimated = sum(stateBytes + bufferBytes)`
