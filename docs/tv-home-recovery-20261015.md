# Revisão local de TV e Início — 15/10/2026

Registro da primeira etapa. O estado mais recente, incluindo VOD429,
qualidade, autenticação e migration aplicada, está no
[lote de recuperação](recovery-batch-20261015.md). As declarações de nenhuma
migration abaixo referem-se à etapa inicial.

Base recebida do GitHub: `962eef0`, incorporada por fast-forward sobre `e3bf14f`. Escopo: TV ao vivo, programação e Início. A validação audiovisual e os testes ficaram com o usuário por solicitação expressa.

## Revisão dos três agentes

| Frente | Entrega |
| --- | --- |
| Transporte IPTV/P2P | Inventário dos dois APKs, contratos recuperados anteriormente, comparação com o site atual, cancelamento, geração por abertura e parada confirmada. |
| Programação/Supabase | Leitura remota limitada, cache temporal, agrupamento de canais e isolamento; tratamento de HTTP429. |
| Início/entrada | Consultas independentes da navegação/foco, entrada independente de capas/VOD e alternativa para recomendações indisponíveis. |

A revisão cruzada também corrigiu duas corridas: reset de mídia invalidando a geração já reservada; bootstrap Supabase antigo restaurando estado depois de negação/detach.

## Alterações

- O modo explícito `ARKHEN_ORIGINAL_ENGINE=1` é respeitado. Antes, o iniciador P2P podia encaminhar reprodução ao OTT. O padrão web continua separado; não se instala ou inicia Android neste patch.
- Cada abertura live recebe `attempt`, conservado em polls/probes. Novo retry cria nova tentativa; leitores simultâneos compartilham preparação e seleções substituídas não podem ressuscitar.
- OTT exige STOP por POST com HTTP204, prazo de12s e sid/gen anterior. Falha conserva a referência e impede nova geração sobreposta. Primeira geração imediata; demais aguardam o restante do intervalo de3s observado no site.
- HTTP429 é preservado no proxy/RPC com Retry-After. HLS.js live permite uma recuperação após30–35s somente depois de playing. Antes disso ou com intervalo maior, exige nova ação. Reset cancela a espera; qualidade automática respeita o intervalo.
- Associação de canais conserva nome completo, região e números; separa somente sufixos de qualidade/codec conhecidos. Identidade nativa explícita pode prevalecer. Não se deduz alias de hash/URL nem se inventa Warner↔WarnerChannel. HTTP alternativo só é usado se o provedor entregar `address_backup`.
- EPG compartilhado agrupa até80 canais, duas leituras concorrentes e prazo de4s. Vazio é ausência de cache; snapshot vencido só permanece se contém programa vigente. Atualizar EPG não apaga catálogos ou outras grades.
- EPG nativo continua compartilhado por sessão e preserva programa vigente após falha/vazio, com espera de30s para recuperação. Sem nuvem, a alternativa pode consultar WPLAY por sessão; não se afirma coleta global saudável nesse cenário.
- Provisionamento da biblioteca pode continuar após orçamento inicial de1,5s. Negação/expiração conserva revogação, epoch próprio e revogação de token tardio. Falha do transporte de autenticação da nuvem permite tentativa direta na mesma origem WPLAY autorizada; rejeição de credenciais não permite essa alternativa.
- TV pode recuperar catálogo nativo autenticado quando o bootstrap/cache falha; o código anterior devolvia vazio nesse caso. VOD conserva seu contrato.
- Entrada libera no primeiro catálogo visível da tela ou após1,5s, depois das guardas de conta/proteção. Capas e preparação continuam em segundo plano com sinal próprio, sem depender de Image.decode/animação/foco.
- Recomendações mantêm o último sucesso e recuperam falhas transitórias em15/30/60s. Navegação/Configurações não abortam a consulta da conta. Sem projeção privada, há seleção do catálogo carregado com filtros e limite; resposta privada válida vazia continua autoritativa.

## Módulos

| Arquivo | Responsabilidade |
| --- | --- |
| `lib/live-playback-session.mjs` | Reserva live, leitores HTTP e Retry-After. |
| `lib/wplay-playback.mjs` | Composição HTTP/OTT/ponte explícita. |
| `lib/wplay-web-playback.mjs` | Associação e propriedade privada das fontes. |
| `lib/wplay-ott-provider.mjs` | sid/gen/stop e intervalo entre gerações. |
| `lib/shared-live-epg.mjs` | Agrupamento e validade da grade compartilhada. |
| `lib/cloud-attachment.mjs` | Orçamento/coalescência da biblioteca. |
| `web/live-playback-session.js` | Token por abertura e HLS nativo Safari/iOS. |
| `web/live-rate-limit-recovery.js` | Recuperação única após429. |
| `web/entry-preparation.js` | Liberação independente da entrada. |
| `web/home-cloud-model.js`, `web/home-cloud-sections.js` | Projeção privada e seleção alternativa. |

## Evidências e limites

Bundle público atual: `https://player.wplayott.com/assets/watch-C_eKJ0Kf.js`, SHA256 `4a12a38b71031890e2ccb2786a39003d4843ec09b9df7a4a19fa5735b2053b63`, obtido sem login/execução. Confirma intervalo3s, STOP204/12s, tratamento429 e seleção Safari/iOS; IDs RPC permanecem iguais. Evidência REA `ev_fa232ef3529f34691740d838563283b763950b95375715f69a5329a23c58c72b`. Relatório privado: `.local/analysiscurrent/official-player-comparison.json`.

Inventário REA: APK original SHA256 `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69`; BinStream `9752e3f6ffdc522bc3e6a1e8e3e7989737bf09db44c0b220e9eb8c637aeb9e9e`. Ambos têm dois DEX e nenhuma entrada JS/HTML/WASM. libgojni é idêntica; libtvcore difere. JADX não estava disponível para nova decompilação; contratos DEX já recuperados foram reutilizados. Isso não demonstra equivalência dos protocolos nem converte BinStream em TVCore.

Leitura limitada do Supabase:24 registros EPG com TTL vencido, três vazios. Não foi confirmada a vigência dos programas da amostra. Nenhuma migration, função remota ou gravação de dados foi aplicada nesta revisão.

Conferência: leitura estática, revisão cruzada, sintaxe dos 21 arquivos JavaScript alterados/adicionados, resolução dos imports da interface com esbuild e whitespace. Sem testes automatizados, navegador ou reprodução. Abertura inferior a cinco segundos, estabilidade prolongada e canal específico ainda não estão comprovados. As diferenças de código identificam mecanismos possíveis; não provam o status HTTP da transmissão fotografada.

Ativação local: o iniciador P2P identificado foi encerrado e o servidor atualizado iniciou em `http://localhost:4173`, preservando `ARKHEN_ORIGINAL_ENGINE=1`, endpoint27043 e porta de mídia8904. Nenhum emulador foi iniciado ou componente instalado nessa ativação. O novo backend exige login novamente porque a sessão anterior ficava em memória. Alterações permanecem locais para a conferência do usuário; não houve novo push/deploy neste lote.

Skills arkhen-iptv, arkhen-p2p e arkhen-supabase instaladas do próprio repositório em `~/.codex/skills/` e seguidas nesta execução. Detalhes da entrada: [home-entry-recovery.md](home-entry-recovery.md).
