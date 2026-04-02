# V1 — Sandbox modular de áudio (serial)

## Objetivo

Construir uma V1 web de um sandbox modular de áudio com **React + AudioWorklet + C++/WASM** para:

- testar módulos DSP em cadeia;
- trocar parâmetros em tempo real;
- carregar arquivo, microfone ou oscilador como fonte;
- salvar/carregar patches em JSON;
- expor métricas básicas de custo de processamento e memória.

> Escopo da V1: processamento em **cadeia serial** (sem grafo arbitrário completo).

## Arquitetura alvo

```text
React UI
  -> patch store / UI store
  -> host Web Audio
       -> AudioContext
       -> AudioWorkletNode único
       -> engine WASM
            -> PatchEngine serial
            -> módulos DSP
```

Princípio central: a UI só edita o **patch JSON**; o áudio roda em um único worklet com engine único em WASM.

## Escopo funcional da V1

### Entradas

- `file`
- `mic`
- `oscillator`

### Módulos iniciais

- `gain`
- `filter`
- `delay`
- `overdrive`
- `chorus`
- `reverb`
- `lfo`
- `mixer` (opcional na primeira entrega)

### Controles por módulo

- `enable` / `bypass`
- `wet/dry` (`mix`) quando aplicável
- parâmetros expostos por schema

### UI

- canvas com nodes arrastáveis
- representação serial da cadeia
- inspector lateral
- transporte básico
- seleção de entrada
- painel de métricas
- save/load de patch

### Métricas

- sample rate atual
- block size real do worklet
- latência reportada do `AudioContext`
- tempo médio de processamento por callback
- tempo de pico por callback
- memória estimada por módulo
- total de módulos ativos

## Fora do escopo da V1

- feedback loops livres
- rotas paralelas arbitrárias
- modulação livre de qualquer parâmetro por qualquer fonte
- MIDI completo
- preset browser avançado
- automações sample-accurate complexas
- troca universal de block size em tempo real

## Fases sugeridas

1. **Engine mínima**: build web, arquivo passando por gain, param em tempo real, sem alocação por callback.
2. **Patch serial**: add/remove/reorder, save/load JSON, sincronização UI/engine.
3. **Módulos base**: gain/filter/delay/overdrive/chorus/reverb/lfo com schema + wet/dry + bypass.
4. **UI de nodes**: drag, ordem visual = ordem de processamento, inspector dinâmico, save/load integrado.
5. **Métricas**: painel estável com callback avg/peak, latência e memória.

## Resultado esperado

No fim da V1, o usuário consegue abrir a página, escolher entrada (`mic`/`file`/`oscillator`), montar cadeia, ajustar parâmetros em tempo real, ouvir imediatamente, salvar/reabrir patch e monitorar custo aproximado.
