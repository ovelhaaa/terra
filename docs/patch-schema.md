# Patch schema (V1)

## Estrutura

```json
{
  "version": 1,
  "meta": {
    "name": "Warm Chorus Delay",
    "author": "user",
    "createdAt": "2026-04-01T12:00:00Z"
  },
  "transport": {
    "playing": true,
    "inputGain": 1.0,
    "outputGain": 0.9
  },
  "input": {
    "type": "file",
    "fileRef": "demo.wav",
    "loop": true,
    "micEnabled": false,
    "oscillator": {
      "waveform": "sine",
      "frequency": 220,
      "amplitude": 0.5
    }
  },
  "chain": [
    {
      "id": "gain_1",
      "type": "gain",
      "enabled": true,
      "bypass": false,
      "mix": 1,
      "params": { "gain": 0.8 }, n. bv
      "ui": { "x": 120, "y": 100 }
    }
  ]
}
```

## Regras

- `version` define compatibilidade de schema.
- `input.type` aceita `file`, `mic`, `oscillator`.
- `chain` é ordenada; ordem do array = ordem de processamento.
- cada módulo deve ter `id` único.
- `params` depende do tipo do módulo.
- `ui` não afeta áudio (somente layout).
- `mix` representa wet/dry local quando o módulo suporta.
- `enabled` desativa lógica do módulo.
- `bypass` pula processamento preservando passagem de sinal.

## Tipos TypeScript

```ts
export type InputType = 'file' | 'mic' | 'oscillator';

export type ModuleType =
  | 'gain'
  | 'filter'
  | 'delay'
  | 'overdrive'
  | 'chorus'
  | 'reverb'
  | 'lfo'
  | 'mixer';

export interface Patch {
  version: number;
  meta: {
    name: string;
    author?: string;
    createdAt?: string;
  };
  transport: {
    playing: boolean;
    inputGain: number;
    outputGain: number;
  };
  input: {
    type: InputType;
    fileRef?: string;
    loop?: boolean;
    micEnabled?: boolean;
    oscillator?: {
      waveform: 'sine' | 'triangle' | 'saw' | 'square';
      frequency: number;
      amplitude: number;
    };
  };
  chain: ModuleInstance[];
}

export interface ModuleInstance {
  id: string;
  type: ModuleType;
  enabled: boolean;
  bypass: boolean;
  mix?: number;
  params: Record<string, number | string | boolean>;
  ui?: {
    x: number;
    y: number;
  };
}
```
